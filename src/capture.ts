import {
  DEFAULT_MAX_BODY_CHARS,
  policyFrom,
  redactBody,
  redactHeaders,
  redactStringMap,
  type RedactionPolicy,
} from "./redact.js";
import {
  encodeRequestContext,
  type RequestContext,
} from "./runtime/request-context.js";

export interface CaptureOptions {
  headers?: boolean;
  body?: boolean;
  maxBodyChars?: number;
  redact?: readonly string[] | false;
  allow?: readonly string[];
  captureStatusFrom?: number;
}

interface HttpRequestLike {
  method?: string;
  path?: string;
  sourceIp?: string;
  userAgent?: string;
}

interface AuthorizerLike {
  jwt?: { claims?: Record<string, unknown> };
  lambda?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  principalId?: string;
}

interface ProxyRequestContextLike {
  requestId?: string;
  http?: HttpRequestLike;
  authorizer?: AuthorizerLike;
}

interface HttpEventLike {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  rawPath?: string;
  rawQueryString?: string;
  requestContext?: ProxyRequestContextLike;
}

interface LambdaContextLike {
  awsRequestId?: string;
}

const DEFAULT_CAPTURE_STATUS_FROM = 400;

interface ResolvedOptions {
  policy: RedactionPolicy;
  includeHeaders: boolean;
  includeBody: boolean;
  captureStatusFrom: number;
}

export function captureRequest<E, R>(
  handler: (event: E, context?: unknown) => R | Promise<R>,
  options?: CaptureOptions,
): (event: E, context?: unknown) => Promise<R>;
export function captureRequest<E, C, R>(
  handler: (event: E, context: C) => R | Promise<R>,
  options?: CaptureOptions,
): (event: E, context: C) => Promise<R>;
export function captureRequest<E, C, R>(
  handler: (event: E, context: C) => R | Promise<R>,
  options: CaptureOptions = {},
): (event: E, context: C) => Promise<R> {
  const resolved: ResolvedOptions = {
    policy: policyFrom({
      redact: resolveRedact(options.redact),
      allow: options.allow,
      maxBodyChars: options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS,
    }),
    includeHeaders: options.headers !== false,
    includeBody: options.body !== false,
    captureStatusFrom:
      options.captureStatusFrom ?? DEFAULT_CAPTURE_STATUS_FROM,
  };

  return async (event: E, context: C): Promise<R> => {
    try {
      const result = await handler(event, context);
      const status = statusOf(result);
      if (status !== null && status >= resolved.captureStatusFrom) {
        emit(event, context, resolved, status);
      }
      return result;
    } catch (err) {
      emit(event, context, resolved, null);
      throw err;
    }
  };
}

function resolveRedact(
  redact: readonly string[] | false | undefined,
): readonly string[] | false {
  if (redact !== undefined) return redact;
  return process.env.WWW_REDACT === "off" ? false : [];
}

function emit(
  event: unknown,
  context: unknown,
  options: ResolvedOptions,
  statusCode: number | null,
): void {
  try {
    const ctx = buildContext(event, context, options, statusCode);
    if (ctx) console.error(encodeRequestContext(ctx));
  } catch {}
}

function buildContext(
  event: unknown,
  context: unknown,
  options: ResolvedOptions,
  statusCode: number | null,
): RequestContext | null {
  const source = asObject<HttpEventLike>(event);
  const proxy = source?.requestContext;
  const http = proxy?.http;
  const ctx: RequestContext = {};

  if (http?.method) ctx.method = http.method;

  const path = http?.path ?? source?.rawPath;
  if (path) {
    ctx.path = source?.rawQueryString
      ? `${path}?${source.rawQueryString}`
      : path;
  }

  const requestId =
    proxy?.requestId ?? asObject<LambdaContextLike>(context)?.awsRequestId;
  if (requestId) ctx.requestId = requestId;

  if (statusCode !== null) ctx.statusCode = statusCode;
  if (http?.sourceIp) ctx.sourceIp = http.sourceIp;

  const userAgent = http?.userAgent ?? headerValue(source?.headers, "user-agent");
  if (userAgent) ctx.userAgent = userAgent;

  const identity = buildIdentity(proxy?.authorizer, options.policy);
  if (identity) ctx.identity = identity;

  if (options.includeHeaders && source?.headers) {
    const headers = redactHeaders(source.headers, options.policy);
    if (Object.keys(headers).length > 0) ctx.headers = headers;
  }

  if (options.includeBody) {
    const body = redactBody(
      source?.body,
      source?.isBase64Encoded === true,
      options.policy,
    );
    if (body) ctx.body = body;
  }

  return hasSubstance(ctx) ? ctx : null;
}

function hasSubstance(ctx: RequestContext): boolean {
  return (
    ctx.method != null ||
    ctx.path != null ||
    ctx.sourceIp != null ||
    ctx.identity != null ||
    ctx.headers != null ||
    ctx.body != null
  );
}

function buildIdentity(
  authorizer: AuthorizerLike | undefined,
  policy: RedactionPolicy,
): Record<string, string> | null {
  if (!authorizer) return null;

  const merged: Record<string, unknown> = {
    ...(authorizer.claims ?? {}),
    ...(authorizer.jwt?.claims ?? {}),
    ...(authorizer.lambda ?? {}),
  };
  if (authorizer.principalId) merged.principalId = authorizer.principalId;

  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value == null || typeof value === "object") continue;
    flat[key] = String(value);
  }

  const identity = redactStringMap(flat, policy, false);
  return Object.keys(identity).length > 0 ? identity : null;
}

function headerValue(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value != null) return value;
  }
  return undefined;
}

function asObject<T>(value: unknown): T | null {
  if (value === null || typeof value !== "object") return null;
  return value as T;
}

function statusOf(result: unknown): number | null {
  const shaped = asObject<{ statusCode?: unknown }>(result);
  const status = shaped?.statusCode;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}
