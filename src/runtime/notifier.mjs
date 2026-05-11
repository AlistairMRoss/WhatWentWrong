import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import {
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { gunzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const sns = new SNSClient({});
const ddb = new DynamoDBClient({});

const TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || "2023-06-01";
const REGION = process.env.AWS_REGION || "us-east-1";
const DEDUP_TABLE = process.env.DEDUP_TABLE;
const DEDUP_COOLDOWN = Number(process.env.DEDUP_COOLDOWN || "3600");

const SYSTEM_PROMPT =
  "You are a debugging assistant for AWS Lambda errors. " +
  "Given an error message and (possibly truncated) stack trace, respond in this exact format:\n\n" +
  "Likely cause: <one sentence>\n" +
  "Suggested fix: <one or two sentences with concrete code or config changes>\n\n" +
  "If you cannot determine the cause from the error alone, say so plainly. Do not speculate.";

export const handler = async (event) => {
  if (!TOPIC_ARN) throw new Error("SNS_TOPIC_ARN env var is required");

  if (event?.awslogs?.data) {
    return await handleLogs(event);
  }
  if (Array.isArray(event?.Records) && event.Records[0]?.Sns) {
    return await handleAlarm(event.Records[0].Sns);
  }
};

async function handleLogs(event) {
  const payload = JSON.parse(
    gunzipSync(Buffer.from(event.awslogs.data, "base64")).toString("utf-8"),
  );
  if (payload.messageType !== "DATA_MESSAGE") return;

  const { logGroup, logStream, logEvents } = payload;
  if (!logEvents || logEvents.length === 0) return;

  const first = logEvents[0];
  const count = logEvents.length;

  const accessLog = tryParseAccessLog(first.message);
  if (accessLog) {
    return await handleAccessLog(logGroup, accessLog, count);
  }

  const fp = fingerprint(first.message);

  let silencedCount = 0;
  if (DEDUP_TABLE) {
    const claim = await tryClaimAlert(fp, count);
    if (claim.suppressed) return;
    silencedCount = claim.silencedDuringCooldown;
  }

  let analysis = "";
  if (API_KEY) {
    try {
      analysis = await analyze(first.message);
    } catch (err) {
      analysis = `(AI analysis failed: ${err?.message ?? err})`;
    }
  }

  await publish({
    subject: subjectForLog(logGroup, first.message),
    body: bodyForLog({
      logGroup,
      logStream,
      count,
      first,
      analysis,
      fingerprint: fp,
      silencedCount,
    }),
  });
}

function tryParseAccessLog(message) {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const raw = parsed.status;
    const status =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number(raw)
          : NaN;
    if (Number.isFinite(status) && status >= 400) {
      return { ...parsed, status };
    }
  } catch {}
  return null;
}

async function handleAccessLog(logGroup, entry, count) {
  const route = entry.routeKey || `${entry.httpMethod ?? "?"} ${entry.path ?? "?"}`;
  const status = entry.status;
  const detail =
    entry.integrationErrorMessage ||
    entry.errorMessage ||
    entry.responseLatency != null
      ? `${entry.integrationErrorMessage ?? ""}`.trim()
      : "";

  const fpKey = `${logGroup}|${route}|${status}`;
  const fp = createHash("sha256").update(fpKey).digest("hex").slice(0, 16);

  let silencedCount = 0;
  if (DEDUP_TABLE) {
    const claim = await tryClaimAlert(fp, count);
    if (claim.suppressed) return;
    silencedCount = claim.silencedDuringCooldown;
  }

  const time = entry.requestTime
    ? entry.requestTime
    : new Date().toISOString();

  const lines = [
    `Time: ${time}`,
    `Route: ${route}`,
    `Status: ${status}`,
  ];
  if (detail) lines.push(`Detail: ${detail}`);
  if (entry.requestId) lines.push(`Request ID: ${entry.requestId}`);
  if (silencedCount > 0) {
    lines.push(
      `Recurring: ${silencedCount} occurrences silenced during cooldown.`,
    );
  }

  await publish({
    subject: `[Alert] ${route}: ${status}`,
    body: lines.join("\n"),
  });
}

async function handleAlarm(snsRecord) {
  let alarm;
  try {
    alarm = JSON.parse(snsRecord.Message);
  } catch {
    return;
  }
  if (alarm?.NewStateValue !== "ALARM") return;

  const resource = resourceFromAlarmName(alarm.AlarmName);
  const metricName = alarm?.Trigger?.MetricName ?? "metric";
  const namespace = alarm?.Trigger?.Namespace ?? "";
  const errorLabel = describeMetric(namespace, metricName);
  const time = alarm?.StateChangeTime
    ? new Date(alarm.StateChangeTime).toISOString()
    : new Date().toISOString();

  const lines = [
    `Time: ${time}`,
    `Resource: ${resource}`,
    `Error: ${errorLabel}`,
  ];

  await publish({
    subject: `[Alert] ${resource}: ${errorLabel}`,
    body: lines.join("\n"),
  });
}

function resourceFromAlarmName(alarmName) {
  if (!alarmName) return "unknown";
  const noHash = alarmName.replace(/-[a-f0-9]{6,}$/, "");
  const noSuffix = noHash.replace(/(4xx|5xx|Age|Errors?)?Alarm$/, "");
  const match = noSuffix.match(/Watch\d+(.+)$/);
  if (match?.[1]) return match[1];
  return noSuffix;
}

function describeMetric(namespace, metricName) {
  if (namespace === "AWS/ApiGateway") return `HTTP ${metricName}`;
  if (namespace === "AWS/SQS" && metricName === "ApproximateAgeOfOldestMessage")
    return "queue backlog (oldest message too old)";
  return metricName;
}

function fingerprint(message) {
  const lines = message.split("\n");
  const sig = [lines[0], lines[1]].filter(Boolean).join("|").slice(0, 500);
  const normalized = sig
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<TS>")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<UUID>",
    )
    .replace(/\b[0-9a-f]{16,}\b/gi, "<HEX>")
    .replace(/\b\d{4,}\b/g, "<N>");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

async function tryClaimAlert(fp, batchCount) {
  const nowSec = Math.floor(Date.now() / 1000);
  const cooldownEnds = nowSec + DEDUP_COOLDOWN;

  try {
    const result = await ddb.send(
      new UpdateItemCommand({
        TableName: DEDUP_TABLE,
        Key: { fingerprint: { S: fp } },
        UpdateExpression:
          "SET cooldownEnds = :end, lastSeen = :now ADD seenCount :batch",
        ConditionExpression:
          "attribute_not_exists(fingerprint) OR cooldownEnds < :now",
        ExpressionAttributeValues: {
          ":end": { N: String(cooldownEnds) },
          ":now": { N: String(nowSec) },
          ":batch": { N: String(batchCount) },
        },
        ReturnValues: "ALL_OLD",
      }),
    );

    const previousCount = result.Attributes?.seenCount?.N
      ? Number(result.Attributes.seenCount.N)
      : 0;

    return { suppressed: false, silencedDuringCooldown: previousCount };
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      try {
        await ddb.send(
          new UpdateItemCommand({
            TableName: DEDUP_TABLE,
            Key: { fingerprint: { S: fp } },
            UpdateExpression:
              "SET lastSeen = :now ADD seenCount :batch",
            ExpressionAttributeValues: {
              ":now": { N: String(nowSec) },
              ":batch": { N: String(batchCount) },
            },
          }),
        );
      } catch {}
      return { suppressed: true, silencedDuringCooldown: 0 };
    }
    throw err;
  }
}

async function analyze(errorText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: errorText.slice(0, 8000),
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const block = data?.content?.find((c) => c.type === "text");
  return block?.text?.trim() ?? "(no analysis returned)";
}

function subjectForLog(logGroup, message) {
  const fn = logGroup.split("/").pop() ?? logGroup;
  const firstLine = message.split("\n")[0].slice(0, 60);
  return `[Alert] ${fn}: ${firstLine}`;
}

function bodyForLog({
  logGroup,
  logStream,
  count,
  first,
  analysis,
  fingerprint,
  silencedCount,
}) {
  const time = new Date(first.timestamp).toISOString();
  const logsUrl =
    `https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}` +
    `#logsV2:log-groups/log-group/${encodeURIComponent(logGroup)}` +
    `/log-events/${encodeURIComponent(logStream)}`;

  const lines = [`Time: ${time}`, `Log group: ${logGroup}`];
  if (count > 1) lines.push(`Errors in batch: ${count} (showing first)`);
  if (silencedCount > 0) {
    lines.push(
      `Recurring: ${silencedCount} occurrences silenced during cooldown.`,
    );
  }
  lines.push(`Fingerprint: ${fingerprint}`);
  lines.push("", "ERROR", "─────", first.message.slice(0, 4000));
  if (analysis) lines.push("", "ANALYSIS", "────────", analysis);
  lines.push("", "LOGS", "────", logsUrl);
  return lines.join("\n");
}

async function publish({ subject, body }) {
  await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: subject.replace(/[^\x20-\x7e]/g, "?").slice(0, 100),
      Message: body,
    }),
  );
}
