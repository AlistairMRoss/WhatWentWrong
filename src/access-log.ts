import { redactStringMap, type RedactionPolicy } from "./redact.js";
import type { RequestContext } from "./runtime/request-context.js";

export interface AccessLogFields {
  authorizerClaims?: readonly string[];
  authorizerContext?: readonly string[];
}

export interface AccessLogStageArgs {
  accessLogSettings?: {
    destinationArn?: unknown;
    format?: unknown;
  };
}

const QUOTED_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["requestTime", "$context.requestTime"],
  ["requestId", "$context.requestId"],
  ["httpMethod", "$context.httpMethod"],
  ["path", "$context.path"],
  ["routeKey", "$context.routeKey"],
  ["protocol", "$context.protocol"],
  ["stage", "$context.stage"],
  ["domainName", "$context.domainName"],
  ["integrationRequestId", "$context.integration.requestId"],
  ["integrationStatus", "$context.integration.status"],
  ["integrationLatency", "$context.integration.latency"],
  ["integrationServiceStatus", "$context.integration.integrationStatus"],
  ["integrationErrorMessage", "$context.integrationErrorMessage"],
  ["errorMessage", "$context.error.message"],
  ["ip", "$context.identity.sourceIp"],
  ["userAgent", "$context.identity.userAgent"],
  ["iamUser", "$context.identity.user"],
];

const NUMERIC_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["status", "$context.status"],
  ["responseLatency", "$context.responseLatency"],
  ["responseLength", "$context.responseLength"],
];

const DEFAULT_CLAIMS: ReadonlyArray<readonly [string, string]> = [
  ["authSub", "sub"],
  ["authEmail", "email"],
  ["authUsername", "username"],
];

export function buildAccessLogFormat(fields: AccessLogFields = {}): string {
  const entries: Record<string, string> = {};

  for (const [key, variable] of QUOTED_FIELDS) {
    entries[key] = `"${variable}"`;
  }
  for (const [key, variable] of NUMERIC_FIELDS) {
    entries[key] = variable;
  }

  entries.authPrincipalId = `"$context.authorizer.principalId"`;

  const claims = fields.authorizerClaims;
  if (claims && claims.length > 0) {
    for (const claim of claims) {
      entries[`auth_${claim}`] = `"$context.authorizer.claims.${claim}"`;
    }
  } else {
    for (const [key, claim] of DEFAULT_CLAIMS) {
      entries[key] = `"$context.authorizer.claims.${claim}"`;
    }
  }

  for (const key of fields.authorizerContext ?? []) {
    entries[`auth_${key}`] = `"$context.authorizer.${key}"`;
  }

  return JSON.stringify(entries);
}

export function accessLogFormat(
  fields: AccessLogFields = {},
): (args: AccessLogStageArgs) => void {
  const format = buildAccessLogFormat(fields);
  return (args: AccessLogStageArgs): void => {
    args.accessLogSettings = { ...args.accessLogSettings, format };
  };
}

const IDENTITY_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["authSub", "sub"],
  ["authEmail", "email"],
  ["authUsername", "username"],
  ["authPrincipalId", "principalId"],
  ["cognitoIdentityId", "cognitoId"],
  ["iamUser", "iamUser"],
];

const CUSTOM_FIELD_PREFIX = "auth_";

export function presentString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "-") return undefined;
  return trimmed;
}

export function numberOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? parsed
    : undefined;
}

export function accessLogRequestContext(
  entry: Record<string, unknown>,
  policy: RedactionPolicy,
): RequestContext | undefined {
  const ctx: RequestContext = {};

  const sourceIp = presentString(entry.ip);
  if (sourceIp) ctx.sourceIp = sourceIp;

  const userAgent = presentString(entry.userAgent);
  if (userAgent) ctx.userAgent = userAgent;

  const identity: Record<string, string> = {};
  for (const [field, label] of IDENTITY_FIELDS) {
    const value = presentString(entry[field]);
    if (value) identity[label] = value;
  }
  for (const [key, value] of Object.entries(entry)) {
    if (!key.startsWith(CUSTOM_FIELD_PREFIX)) continue;
    const present = presentString(value);
    if (present) identity[key.slice(CUSTOM_FIELD_PREFIX.length)] = present;
  }
  if (Object.keys(identity).length > 0) {
    ctx.identity = redactStringMap(identity, policy, false);
  }

  return ctx.sourceIp || ctx.userAgent || ctx.identity ? ctx : undefined;
}
