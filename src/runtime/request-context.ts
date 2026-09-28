export const REQUEST_CONTEXT_SENTINEL = "whatwentwrong:request-context";

export interface RequestContext {
  method?: string;
  path?: string;
  requestId?: string;
  statusCode?: number;
  sourceIp?: string;
  userAgent?: string;
  identity?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
}

export interface LogEventLike {
  timestamp: number;
  message: string;
}

export interface ParsedContext<T extends LogEventLike> {
  event: T;
  ctx: RequestContext;
}

export function encodeRequestContext(ctx: RequestContext): string {
  return `ERROR ${REQUEST_CONTEXT_SENTINEL} ${JSON.stringify(ctx)}`;
}

function parseFrom(message: string): RequestContext | null {
  const at = message.indexOf(REQUEST_CONTEXT_SENTINEL);
  if (at < 0) return null;
  const start = message.indexOf("{", at + REQUEST_CONTEXT_SENTINEL.length);
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(message.slice(start));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RequestContext;
    }
  } catch {}
  return null;
}

export function tryParseRequestContext(message: string): RequestContext | null {
  const direct = parseFrom(message);
  if (direct) return direct;

  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const outer: unknown = JSON.parse(trimmed);
    if (outer !== null && typeof outer === "object" && !Array.isArray(outer)) {
      const inner = (outer as Record<string, unknown>).message;
      if (typeof inner === "string") return parseFrom(inner);
    }
  } catch {}
  return null;
}

export function partitionLogEvents<T extends LogEventLike>(
  events: readonly T[],
): { errors: T[]; contexts: Array<ParsedContext<T>> } {
  const errors: T[] = [];
  const contexts: Array<ParsedContext<T>> = [];
  for (const event of events) {
    const ctx = tryParseRequestContext(event.message);
    if (ctx) contexts.push({ event, ctx });
    else errors.push(event);
  }
  return { errors, contexts };
}

export function correlate<T extends LogEventLike>(
  error: T | undefined,
  contexts: ReadonlyArray<ParsedContext<T>>,
): RequestContext | undefined {
  const first = contexts[0];
  if (!first) return undefined;

  if (error) {
    const byRequestId = contexts.find(
      (candidate) =>
        typeof candidate.ctx.requestId === "string" &&
        candidate.ctx.requestId.length > 0 &&
        error.message.includes(candidate.ctx.requestId),
    );
    if (byRequestId) return byRequestId.ctx;
  }

  if (contexts.length === 1 || !error) return first.ctx;

  let best = first;
  let bestDelta = Math.abs(first.event.timestamp - error.timestamp);
  for (const candidate of contexts.slice(1)) {
    const delta = Math.abs(candidate.event.timestamp - error.timestamp);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best.ctx;
}

export function routeLabel(ctx: RequestContext): string {
  return `${ctx.method ?? "?"} ${ctx.path ?? "?"}`;
}

export function synthesizeErrorText(ctx: RequestContext): string {
  const status = ctx.statusCode ?? 0;
  return `HTTP ${status} returned from ${routeLabel(ctx)} without throwing`;
}
