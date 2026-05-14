import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import {
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { gunzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Resource } from "sst";
import { SourceMapConsumer } from "source-map";

const sns = new SNSClient({});
const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

const TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || "2023-06-01";
const REGION = process.env.AWS_REGION || "us-east-1";
const DEDUP_TABLE = process.env.DEDUP_TABLE;
const DEDUP_COOLDOWN = Number(process.env.DEDUP_COOLDOWN || "3600");
const SOURCE_MAP_BUCKET = process.env.SOURCE_MAP_BUCKET;

const AI_EXPECTED = process.env.AI_EXPECTED === "true";

const API_KEY: string | undefined = (() => {
  try {
    const value = (Resource as unknown as { AiApiKey?: { value: string } })
      .AiApiKey?.value;
    if (!value && AI_EXPECTED) {
      console.warn(
        "[whatwentwrong] AI is enabled in Monitor but Resource.AiApiKey has no value. " +
          "Run `sst secret set AiApiKey sk-ant-...` and redeploy.",
      );
    }
    return value || undefined;
  } catch (err: any) {
    if (AI_EXPECTED) {
      console.warn(
        "[whatwentwrong] AI is enabled in Monitor but Resource.AiApiKey is not linked: " +
          (err?.message ?? err) +
          ". Run `sst secret set AiApiKey sk-ant-...` and redeploy.",
      );
    }
    return undefined;
  }
})();

const SYSTEM_PROMPT =
  "You are a debugging assistant for AWS Lambda errors. " +
  "Given an error message, stack trace, and (when available) original source snippets at each frame, respond in this exact format:\n\n" +
  "Likely cause: <one sentence>\n" +
  "Suggested fix: <one or two sentences with concrete code or config changes, citing original file:line>\n\n" +
  "If you cannot determine the cause from the available context, say so plainly. Do not speculate.";

const sourceMapCache = new Map<string, SourceMapConsumer>();

type LogEvent = { timestamp: number; message: string };
type LogsPayload = {
  messageType: string;
  logGroup: string;
  logStream: string;
  logEvents: LogEvent[];
};
type AwsLogsEvent = { awslogs: { data: string } };
type SnsEvent = { Records: Array<{ Sns: { Message: string } }> };

export const handler = async (event: AwsLogsEvent | SnsEvent | unknown) => {
  if (!TOPIC_ARN) throw new Error("SNS_TOPIC_ARN env var is required");

  if ((event as AwsLogsEvent)?.awslogs?.data) {
    return await handleLogs(event as AwsLogsEvent);
  }
  const records = (event as SnsEvent)?.Records;
  if (Array.isArray(records) && records[0]?.Sns) {
    return await handleAlarm(records[0].Sns);
  }
};

async function handleLogs(event: AwsLogsEvent) {
  const payload: LogsPayload = JSON.parse(
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

  let resolvedFrames: ResolvedFrame[] = [];
  if (SOURCE_MAP_BUCKET) {
    const consumer = await getSourceMapConsumer(logGroup);
    if (consumer) {
      resolvedFrames = resolveStackTrace(first.message, consumer);
    }
  }

  const enrichedMessage =
    resolvedFrames.length > 0
      ? `${first.message}\n\nResolved (via source map):\n${formatResolvedTrace(resolvedFrames)}\n\nSource at each frame:\n${formatSnippets(resolvedFrames)}`
      : first.message;

  let analysis = "";
  if (API_KEY) {
    try {
      analysis = await analyze(enrichedMessage);
    } catch (err: any) {
      analysis = `(AI analysis failed: ${err?.message ?? err})`;
    }
  } else if (AI_EXPECTED) {
    analysis =
      "(AI analysis skipped: AiApiKey secret has no value or is not linked. " +
      "Run `sst secret set AiApiKey sk-ant-...` and redeploy.)";
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
      resolvedFrames,
    }),
  });
}

type AccessLog = Record<string, any> & { status: number };

function tryParseAccessLog(message: string): AccessLog | null {
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

async function handleAccessLog(
  logGroup: string,
  entry: AccessLog,
  count: number,
) {
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

  let analysis = "";
  if (API_KEY) {
    const promptText = formatAccessLogForAi({ route, status, detail, entry });
    try {
      analysis = await analyze(promptText);
    } catch (err: any) {
      analysis = `(AI analysis failed: ${err?.message ?? err})`;
    }
  } else if (AI_EXPECTED) {
    analysis =
      "(AI analysis skipped: AiApiKey secret has no value or is not linked. " +
      "Run `sst secret set AiApiKey sk-ant-...` and redeploy.)";
  }

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
  if (analysis) lines.push("", "ANALYSIS", "────────", analysis);

  await publish({
    subject: `[Alert] ${route}: ${status}`,
    body: lines.join("\n"),
  });
}

function formatAccessLogForAi({
  route,
  status,
  detail,
  entry,
}: {
  route: string;
  status: number;
  detail: string;
  entry: AccessLog;
}): string {
  const parts = [
    `API Gateway access log entry for a failed request.`,
    `Route: ${route}`,
    `Status: ${status}`,
  ];
  if (detail) parts.push(`Detail: ${detail}`);
  if (entry.requestId) parts.push(`Request ID: ${entry.requestId}`);
  parts.push("", "Full access log entry:", JSON.stringify(entry, null, 2));
  parts.push(
    "",
    "Note: this is API Gateway's access log, not a function stack trace. " +
      "If you cannot determine the cause from this alone, suggest the user check the backing function's logs.",
  );
  return parts.join("\n");
}

async function handleAlarm(snsRecord: { Message: string }) {
  let alarm: any;
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

function resourceFromAlarmName(alarmName: string | undefined): string {
  if (!alarmName) return "unknown";
  const noHash = alarmName.replace(/-[a-f0-9]{6,}$/, "");
  const noSuffix = noHash.replace(/(4xx|5xx|Age|Errors?)?Alarm$/, "");
  const match = noSuffix.match(/Watch\d+(.+)$/);
  if (match?.[1]) return match[1];
  return noSuffix;
}

function describeMetric(namespace: string, metricName: string): string {
  if (namespace === "AWS/ApiGateway") return `HTTP ${metricName}`;
  if (namespace === "AWS/SQS" && metricName === "ApproximateAgeOfOldestMessage")
    return "queue backlog (oldest message too old)";
  return metricName;
}

function fingerprint(message: string): string {
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

async function tryClaimAlert(
  fp: string,
  batchCount: number,
): Promise<{ suppressed: boolean; silencedDuringCooldown: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cooldownEnds = nowSec + DEDUP_COOLDOWN;

  try {
    const result = (await ddb.send(
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
    )) as { Attributes?: Record<string, { N?: string }> };

    const previousCount = result.Attributes?.seenCount?.N
      ? Number(result.Attributes.seenCount.N)
      : 0;

    return { suppressed: false, silencedDuringCooldown: previousCount };
  } catch (err: any) {
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

async function analyze(errorText: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY!,
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

  const data: any = await res.json();
  const block = data?.content?.find((c: any) => c.type === "text");
  return block?.text?.trim() ?? "(no analysis returned)";
}

function subjectForLog(logGroup: string, message: string): string {
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
  resolvedFrames,
}: {
  logGroup: string;
  logStream: string;
  count: number;
  first: LogEvent;
  analysis: string;
  fingerprint: string;
  silencedCount: number;
  resolvedFrames: ResolvedFrame[];
}): string {
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
  if (resolvedFrames.length > 0) {
    lines.push(
      "",
      "RESOLVED (source map)",
      "─────────────────────",
      formatResolvedTrace(resolvedFrames),
      "",
      "SOURCE",
      "──────",
      formatSnippets(resolvedFrames),
    );
  }
  if (analysis) lines.push("", "ANALYSIS", "────────", analysis);
  lines.push("", "LOGS", "────", logsUrl);
  return lines.join("\n");
}

interface ResolvedFrame {
  rawFrame: string;
  source: string;
  line: number;
  column: number;
  name?: string;
  snippet?: string;
}

async function getSourceMapConsumer(
  logGroupName: string,
): Promise<SourceMapConsumer | null> {
  if (!SOURCE_MAP_BUCKET) return null;
  const cached = sourceMapCache.get(logGroupName);
  if (cached) return cached;

  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: SOURCE_MAP_BUCKET,
        Key: `${logGroupName}.map`,
      }),
    );
    if (!result.Body) return null;
    const text = await result.Body.transformToString();
    const consumer = await new SourceMapConsumer(JSON.parse(text));
    sourceMapCache.set(logGroupName, consumer);
    return consumer;
  } catch {
    return null;
  }
}

function resolveStackTrace(
  message: string,
  consumer: SourceMapConsumer,
): ResolvedFrame[] {
  const frames: ResolvedFrame[] = [];
  const re = /at\s+(?:\S+\s+)?\(?([^\s()]+\.m?js):(\d+):(\d+)\)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(message))) {
    const [rawFrame, , lineStr, colStr] = match;
    const line = parseInt(lineStr, 10);
    const column = parseInt(colStr, 10);
    if (!Number.isFinite(line) || !Number.isFinite(column)) continue;

    const orig = consumer.originalPositionFor({ line, column });
    if (!orig.source || !orig.line) continue;

    const sourceText = consumer.sourceContentFor(orig.source, true);
    const snippet = sourceText
      ? extractSnippet(sourceText, orig.line, 3)
      : undefined;

    frames.push({
      rawFrame,
      source: orig.source,
      line: orig.line,
      column: orig.column ?? 0,
      name: orig.name ?? undefined,
      snippet,
    });

    if (frames.length >= 8) break;
  }
  return frames;
}

function extractSnippet(
  source: string,
  line: number,
  context: number,
): string {
  const lines = source.split("\n");
  const start = Math.max(0, line - context - 1);
  const end = Math.min(lines.length, line + context);
  return lines
    .slice(start, end)
    .map((l, i) => {
      const lineNo = start + i + 1;
      const marker = lineNo === line ? ">" : " ";
      return `${marker} ${String(lineNo).padStart(4)} | ${l}`;
    })
    .join("\n");
}

function formatResolvedTrace(frames: ResolvedFrame[]): string {
  return frames
    .map((f) => {
      const fnPart = f.name ? `${f.name} ` : "";
      return `  at ${fnPart}(${f.source}:${f.line}:${f.column})`;
    })
    .join("\n");
}

function formatSnippets(frames: ResolvedFrame[]): string {
  return frames
    .filter((f) => f.snippet)
    .map((f) => `── ${f.source}:${f.line} ──\n${f.snippet}`)
    .join("\n\n");
}

async function publish({ subject, body }: { subject: string; body: string }) {
  await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: subject.replace(/[^\x20-\x7e]/g, "?").slice(0, 100),
      Message: body,
    }),
  );
}
