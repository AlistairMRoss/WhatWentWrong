import { routeLabel, type RequestContext } from "./request-context.js";

export interface LogAlert {
  kind: "log";
  logGroup: string;
  logStream: string;
  count: number;
  timestamp: number;
  errorText: string;
  analysis: string;
  fingerprint: string;
  silencedCount: number;
  sourceFiles: string[];
  region: string;
  requestContext?: RequestContext;
}

export interface AccessLogAlert {
  kind: "accessLog";
  route: string;
  status: number;
  time: string;
  detail: string;
  requestId?: string;
  latencyMs?: number;
  analysis: string;
  silencedCount: number;
  requestContext?: RequestContext;
}

export interface AlarmAlert {
  kind: "alarm";
  resource: string;
  errorLabel: string;
  time: string;
}

export type Alert = LogAlert | AccessLogAlert | AlarmAlert;

export interface RenderOptions {
  errorChars: number;
  requestChars: number;
}

export function subjectFor(alert: Alert): string {
  switch (alert.kind) {
    case "log": {
      const fn = alert.logGroup.split("/").pop() ?? alert.logGroup;
      const firstLine = alert.errorText.split("\n")[0].slice(0, 60);
      return `[Alert] ${fn}: ${firstLine}`;
    }
    case "accessLog":
      return `[Alert] ${alert.route}: ${alert.status}`;
    case "alarm":
      return `[Alert] ${alert.resource}: ${alert.errorLabel}`;
  }
}

export function renderText(alert: Alert, opts: RenderOptions): string {
  switch (alert.kind) {
    case "log":
      return renderLog(alert, opts);
    case "accessLog":
      return renderAccessLog(alert, opts);
    case "alarm":
      return renderAlarm(alert);
  }
}

function renderLog(alert: LogAlert, opts: RenderOptions): string {
  const time = new Date(alert.timestamp).toISOString();
  const lines = [`Time: ${time}`, `Log group: ${alert.logGroup}`];
  if (alert.requestContext?.requestId) {
    lines.push(`Request ID: ${alert.requestContext.requestId}`);
  }
  if (alert.count > 1) {
    lines.push(`Errors in batch: ${alert.count} (showing first)`);
  }
  if (alert.silencedCount > 0) {
    lines.push(
      `Recurring: ${alert.silencedCount} occurrences silenced during cooldown.`,
    );
  }
  lines.push(`Fingerprint: ${alert.fingerprint}`);
  if (alert.sourceFiles.length > 0) {
    lines.push(`Source context: ${alert.sourceFiles.join(", ")}`);
  }
  if (alert.requestContext) {
    const block = renderRequest(alert.requestContext, opts.requestChars);
    if (block.length > 0) lines.push("", ...block);
  }
  lines.push("", "ERROR", "─────", alert.errorText.slice(0, opts.errorChars));
  if (alert.analysis) {
    lines.push("", "ANALYSIS", "────────", alert.analysis);
  }
  lines.push("", "LOGS", "────", consoleLogsUrl(alert));
  return lines.join("\n");
}

function renderAccessLog(alert: AccessLogAlert, opts: RenderOptions): string {
  const lines = [
    `Time: ${alert.time}`,
    `Route: ${alert.route}`,
    `Status: ${alert.status}`,
  ];
  if (alert.detail) lines.push(`Detail: ${alert.detail}`);
  if (alert.requestId) lines.push(`Request ID: ${alert.requestId}`);
  if (alert.latencyMs != null) lines.push(`Latency: ${alert.latencyMs}ms`);
  if (alert.silencedCount > 0) {
    lines.push(
      `Recurring: ${alert.silencedCount} occurrences silenced during cooldown.`,
    );
  }
  if (alert.requestContext) {
    const block = renderRequest(alert.requestContext, opts.requestChars);
    if (block.length > 0) lines.push("", ...block);
  }
  if (alert.analysis) {
    lines.push("", "ANALYSIS", "────────", alert.analysis);
  }
  return lines.join("\n");
}

function renderAlarm(alert: AlarmAlert): string {
  return [
    `Time: ${alert.time}`,
    `Resource: ${alert.resource}`,
    `Error: ${alert.errorLabel}`,
  ].join("\n");
}

function consoleLogsUrl(alert: LogAlert): string {
  return (
    `https://${alert.region}.console.aws.amazon.com/cloudwatch/home?region=${alert.region}` +
    `#logsV2:log-groups/log-group/${encodeURIComponent(alert.logGroup)}` +
    `/log-events/${encodeURIComponent(alert.logStream)}`
  );
}

const REQUEST_HEADING = ["REQUEST", "───────"];
const BODY_OMITTED = ["Body:", "  <omitted — over channel size limit>"];

export function renderRequest(ctx: RequestContext, budget: number): string[] {
  if (budget <= 0) return [];

  const core = requestCoreLines(ctx);
  const headers = requestHeaderLines(ctx, false);
  const headerNames = requestHeaderLines(ctx, true);
  const body = requestBodyLines(ctx.body);
  if (core.length === 0 && headers.length === 0 && body.length === 0) return [];

  const omitted = body.length > 0 ? BODY_OMITTED : [];
  const candidates: string[][] = [
    [...core, ...headers, ...body],
    [...core, ...headers, ...omitted],
    [...core, ...headerNames, ...omitted],
    core,
  ];

  for (const candidate of candidates) {
    const lines = [...REQUEST_HEADING, ...candidate];
    if (lines.join("\n").length <= budget) return lines;
  }
  return truncate([...REQUEST_HEADING, ...core].join("\n"), budget).split("\n");
}

function requestCoreLines(ctx: RequestContext): string[] {
  const lines: string[] = [];
  if (ctx.method != null || ctx.path != null) {
    lines.push(`Method: ${routeLabel(ctx)}`);
  }
  if (ctx.statusCode != null) lines.push(`Returned: ${ctx.statusCode}`);
  if (ctx.sourceIp) lines.push(`Source IP: ${ctx.sourceIp}`);
  if (ctx.userAgent) lines.push(`User agent: ${ctx.userAgent}`);
  const identity = ctx.identity ? Object.entries(ctx.identity) : [];
  if (identity.length > 0) {
    lines.push(
      `Identity: ${identity.map(([key, value]) => `${key}=${value}`).join(", ")}`,
    );
  }
  return lines;
}

function requestHeaderLines(ctx: RequestContext, namesOnly: boolean): string[] {
  const entries = ctx.headers ? Object.entries(ctx.headers) : [];
  if (entries.length === 0) return [];
  if (namesOnly) {
    return ["Headers:", `  ${entries.map(([key]) => key).join(", ")}`];
  }
  return ["Headers:", ...entries.map(([key, value]) => `  ${key}: ${value}`)];
}

function requestBodyLines(body: string | undefined): string[] {
  if (!body) return [];
  return ["Body:", ...body.split("\n").map((line) => `  ${line}`)];
}

export function escapeCodeFence(text: string): string {
  return text.replace(/`/g, "ˋ");
}

export function escapeSlack(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const MAX_WEBHOOK_SUBJECT = 200;

export interface WebhookLimits {
  errorChars: number;
  requestChars: number;
  totalChars: number;
  escape?: (text: string) => string;
}

export function webhookMessage(
  alert: Alert,
  bold: string,
  limits: WebhookLimits,
): string {
  const escape = limits.escape ?? ((text: string): string => text);
  const subject = escape(
    escapeCodeFence(subjectFor(alert).slice(0, MAX_WEBHOOK_SUBJECT)),
  );
  const header = `${bold}${subject}${bold}\n`;
  const fence = "```\n\n```";
  const budget = limits.totalChars - header.length - fence.length;
  const body = escape(
    escapeCodeFence(
      renderText(alert, {
        errorChars: limits.errorChars,
        requestChars: limits.requestChars,
      }),
    ),
  );
  return `${header}\`\`\`\n${truncate(body, budget)}\n\`\`\``;
}

export interface SlackPayload {
  text: string;
}

export interface DiscordPayload {
  content: string;
  allowed_mentions: { parse: string[] };
}

export function slackPayload(
  alert: Alert,
  limits: Omit<WebhookLimits, "escape">,
): SlackPayload {
  return { text: webhookMessage(alert, "*", { ...limits, escape: escapeSlack }) };
}

export function discordPayload(
  alert: Alert,
  limits: Omit<WebhookLimits, "escape">,
): DiscordPayload {
  return {
    content: webhookMessage(alert, "**", limits),
    allowed_mentions: { parse: [] },
  };
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const marker = "\n… truncated";
  if (max <= marker.length) return text.slice(0, max);
  return text.slice(0, max - marker.length) + marker;
}
