import { describe, expect, test } from "bun:test";
import {
  REQUEST_CONTEXT_SENTINEL,
  correlate,
  encodeRequestContext,
  partitionLogEvents,
  routeLabel,
  synthesizeErrorText,
  tryParseRequestContext,
  type RequestContext,
} from "./request-context.js";
import { renderText } from "./render.js";

const CTX: RequestContext = {
  method: "POST",
  path: "/v1/migrate",
  requestId: "abc-123",
  statusCode: 500,
  sourceIp: "41.13.8.22",
  userAgent: "Mozilla/5.0",
  identity: { sub: "u_8821" },
  headers: { "x-tenant-id": "acme" },
  body: '{"userId":"u_8821"}',
};

const event = (timestamp: number, message: string) => ({ timestamp, message });

describe("encodeRequestContext", () => {
  test("emits a single line carrying the ERROR token and the sentinel", () => {
    const line = encodeRequestContext(CTX);
    expect(line.split("\n")).toHaveLength(1);
    expect(line.startsWith("ERROR ")).toBe(true);
    expect(line).toContain(REQUEST_CONTEXT_SENTINEL);
  });

  test("keeps a multi-line body on one line", () => {
    const line = encodeRequestContext({ ...CTX, body: "line one\nline two" });
    expect(line.split("\n")).toHaveLength(1);
  });

  test("round-trips through tryParseRequestContext", () => {
    expect(tryParseRequestContext(encodeRequestContext(CTX))).toEqual(CTX);
  });
});

describe("tryParseRequestContext", () => {
  test("parses the TEXT log format with the runtime's own prefix", () => {
    const message = `2026-09-15T10:00:00.000Z\tabc-123\tERROR\t${encodeRequestContext(CTX)}`;
    expect(tryParseRequestContext(message)).toEqual(CTX);
  });

  test("parses the JSON log format", () => {
    const message = JSON.stringify({
      timestamp: "2026-09-15T10:00:00.000Z",
      level: "ERROR",
      requestId: "abc-123",
      message: encodeRequestContext(CTX),
    });
    expect(tryParseRequestContext(message)).toEqual(CTX);
  });

  test("returns null for an ordinary stack trace", () => {
    expect(
      tryParseRequestContext("ERROR TypeError: boom\n    at handler (/var/task/index.mjs:1:1)"),
    ).toBeNull();
  });

  test("returns null for an access-log JSON line", () => {
    expect(
      tryParseRequestContext('{"routeKey":"POST /v1/migrate","status":500}'),
    ).toBeNull();
  });

  test("returns null when the sentinel has no JSON after it", () => {
    expect(tryParseRequestContext(`ERROR ${REQUEST_CONTEXT_SENTINEL}`)).toBeNull();
  });

  test("returns null when the JSON after the sentinel is malformed", () => {
    expect(
      tryParseRequestContext(`ERROR ${REQUEST_CONTEXT_SENTINEL} {"method":`),
    ).toBeNull();
  });

  test("returns null when the payload is not an object", () => {
    expect(
      tryParseRequestContext(`ERROR ${REQUEST_CONTEXT_SENTINEL} [1,2]`),
    ).toBeNull();
  });
});

describe("partitionLogEvents", () => {
  test("separates sentinel lines from error lines", () => {
    const stack = event(10, "ERROR TypeError: boom");
    const sentinel = event(9, encodeRequestContext(CTX));
    const { errors, contexts } = partitionLogEvents([sentinel, stack]);
    expect(errors).toEqual([stack]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].ctx).toEqual(CTX);
  });

  test("handles a batch with no contexts", () => {
    const { errors, contexts } = partitionLogEvents([event(1, "ERROR boom")]);
    expect(errors).toHaveLength(1);
    expect(contexts).toHaveLength(0);
  });

  test("handles a context-only batch", () => {
    const { errors, contexts } = partitionLogEvents([
      event(1, encodeRequestContext(CTX)),
    ]);
    expect(errors).toHaveLength(0);
    expect(contexts).toHaveLength(1);
  });

  test("handles an empty batch", () => {
    expect(partitionLogEvents([])).toEqual({ errors: [], contexts: [] });
  });
});

describe("correlate", () => {
  const other: RequestContext = { ...CTX, requestId: "zzz-999", path: "/v1/other" };

  test("returns undefined when there are no contexts", () => {
    expect(correlate(event(1, "ERROR boom"), [])).toBeUndefined();
  });

  test("prefers a requestId match over the nearest timestamp", () => {
    const contexts = partitionLogEvents([
      event(100, encodeRequestContext(CTX)),
      event(1, encodeRequestContext(other)),
    ]).contexts;
    const error = event(2, "ERROR boom RequestId: abc-123");
    expect(correlate(error, contexts)?.requestId).toBe("abc-123");
  });

  test("falls back to the only context in the batch", () => {
    const contexts = partitionLogEvents([event(900, encodeRequestContext(CTX))]).contexts;
    expect(correlate(event(1, "ERROR boom"), contexts)).toEqual(CTX);
  });

  test("falls back to the nearest timestamp", () => {
    const contexts = partitionLogEvents([
      event(100, encodeRequestContext(CTX)),
      event(5, encodeRequestContext(other)),
    ]).contexts;
    expect(correlate(event(4, "ERROR boom"), contexts)?.requestId).toBe("zzz-999");
  });

  test("returns the first context when there is no error event", () => {
    const contexts = partitionLogEvents([
      event(100, encodeRequestContext(CTX)),
      event(5, encodeRequestContext(other)),
    ]).contexts;
    expect(correlate(undefined, contexts)?.requestId).toBe("abc-123");
  });

  test("ignores an empty requestId when matching", () => {
    const contexts = partitionLogEvents([
      event(100, encodeRequestContext({ ...CTX, requestId: "" })),
    ]).contexts;
    expect(correlate(event(1, "ERROR boom"), contexts)?.path).toBe("/v1/migrate");
  });
});

describe("routeLabel and synthesizeErrorText", () => {
  test("formats a known route", () => {
    expect(routeLabel(CTX)).toBe("POST /v1/migrate");
    expect(synthesizeErrorText(CTX)).toBe(
      "HTTP 500 returned from POST /v1/migrate without throwing",
    );
  });

  test("degrades when method and path are missing", () => {
    expect(routeLabel({})).toBe("? ?");
    expect(synthesizeErrorText({})).toBe("HTTP 0 returned from ? ? without throwing");
  });
});

describe("notifier pipeline", () => {
  const FULL = { errorChars: 4000, requestChars: 4000 };

  function pipeline(messages: Array<[number, string]>) {
    const events = messages.map(([timestamp, message]) => ({ timestamp, message }));
    const { errors, contexts } = partitionLogEvents(events);
    const requestContext = correlate(errors[0], contexts);
    const anchor = errors[0] ?? contexts[0]?.event;
    if (!anchor) return null;
    const errorText = errors[0]
      ? errors[0].message
      : requestContext
        ? synthesizeErrorText(requestContext)
        : "";
    return renderText(
      {
        kind: "log",
        logGroup: "/aws/lambda/my-app-Api",
        logStream: "2026/09/15/[$LATEST]abc",
        count: errors.length || contexts.length,
        timestamp: anchor.timestamp,
        errorText,
        analysis: "Likely cause: x",
        fingerprint: "deadbeefdeadbeef",
        silencedCount: 0,
        sourceFiles: [],
        region: "eu-west-1",
        requestContext,
      },
      FULL,
    );
  }

  test("a sentinel line plus a stack trace renders one enriched alert", () => {
    const body = pipeline([
      [1000, encodeRequestContext(CTX)],
      [1001, "ERROR TypeError: cannot read x\n    at handler (index.ts:4:2)"],
    ]);
    expect(body).toContain("Request ID: abc-123");
    expect(body).toContain("REQUEST");
    expect(body).toContain("Identity: sub=u_8821");
    expect(body).toContain('Body:\n  {"userId":"u_8821"}');
    expect(body).toContain("TypeError: cannot read x");
    expect(body).not.toContain("Errors in batch");
  });

  test("the batch count excludes the sentinel line", () => {
    const body = pipeline([
      [1000, encodeRequestContext(CTX)],
      [1001, "ERROR one"],
      [1002, "ERROR two"],
    ]);
    expect(body).toContain("Errors in batch: 2 (showing first)");
  });

  test("a sentinel line alone renders the swallowed-status alert", () => {
    const body = pipeline([[1000, encodeRequestContext({ ...CTX, statusCode: 500 })]]);
    expect(body).toContain("HTTP 500 returned from POST /v1/migrate without throwing");
    expect(body).toContain("Returned: 500");
    expect(body).toContain("Identity: sub=u_8821");
  });

  test("a batch with no sentinel renders exactly as before", () => {
    const body = pipeline([[1000, "ERROR TypeError: boom"]]);
    expect(body).not.toContain("REQUEST");
    expect(body).toContain("TypeError: boom");
  });
});
