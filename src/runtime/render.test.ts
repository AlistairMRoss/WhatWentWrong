import { describe, expect, test } from "bun:test";
import {
  escapeCodeFence,
  renderRequest,
  renderText,
  subjectFor,
  truncate,
  webhookMessage,
  type AccessLogAlert,
  type AlarmAlert,
  type LogAlert,
} from "./render.js";
import type { RequestContext } from "./request-context.js";

const SLACK = { errorChars: 3500, requestChars: 2000, totalChars: 39000 };
const DISCORD = { errorChars: 800, requestChars: 300, totalChars: 1990 };

const LOG: LogAlert = {
  kind: "log",
  logGroup: "/aws/lambda/my-app-Api",
  logStream: "2026/07/27/[$LATEST]abc",
  count: 1,
  timestamp: Date.UTC(2026, 6, 27, 12, 0, 0),
  errorText: "TypeError: cannot read x\n    at handler (index.ts:4:2)",
  analysis: "Likely cause: x\nSuggested fix: y",
  fingerprint: "deadbeefdeadbeef",
  silencedCount: 0,
  sourceFiles: [],
  region: "eu-west-1",
};

const ACCESS: AccessLogAlert = {
  kind: "accessLog",
  route: "GET /users",
  status: 500,
  time: "27/Jul/2026:12:00:00 +0000",
  detail: "",
  analysis: "",
  silencedCount: 0,
};

const ALARM: AlarmAlert = {
  kind: "alarm",
  resource: "Api",
  errorLabel: "HTTP 5xx",
  time: "2026-07-27T12:00:00.000Z",
};

describe("subjectFor", () => {
  test("log uses the log group tail and the first line of the error", () => {
    expect(subjectFor(LOG)).toBe(
      "[Alert] my-app-Api: TypeError: cannot read x",
    );
  });

  test("log clamps the first line to 60 characters", () => {
    const subject = subjectFor({ ...LOG, errorText: "E".repeat(200) });
    expect(subject).toBe(`[Alert] my-app-Api: ${"E".repeat(60)}`);
  });

  test("accessLog and alarm subjects", () => {
    expect(subjectFor(ACCESS)).toBe("[Alert] GET /users: 500");
    expect(subjectFor(ALARM)).toBe("[Alert] Api: HTTP 5xx");
  });
});

describe("renderText — log", () => {
  test("matches the established plain-text layout", () => {
    expect(renderText(LOG, { errorChars: 4000, requestChars: 4000 })).toBe(
      [
        "Time: 2026-07-27T12:00:00.000Z",
        "Log group: /aws/lambda/my-app-Api",
        "Fingerprint: deadbeefdeadbeef",
        "",
        "ERROR",
        "─────",
        "TypeError: cannot read x\n    at handler (index.ts:4:2)",
        "",
        "ANALYSIS",
        "────────",
        "Likely cause: x\nSuggested fix: y",
        "",
        "LOGS",
        "────",
        "https://eu-west-1.console.aws.amazon.com/cloudwatch/home?region=eu-west-1" +
          "#logsV2:log-groups/log-group/%2Faws%2Flambda%2Fmy-app-Api" +
          "/log-events/2026%2F07%2F27%2F%5B%24LATEST%5Dabc",
      ].join("\n"),
    );
  });

  test("optional lines appear only when relevant", () => {
    const body = renderText(
      { ...LOG, count: 7, silencedCount: 3, sourceFiles: ["src/a.ts"] },
      { errorChars: 4000, requestChars: 4000 },
    );
    expect(body).toContain("Errors in batch: 7 (showing first)");
    expect(body).toContain("Recurring: 3 occurrences silenced during cooldown.");
    expect(body).toContain("Source context: src/a.ts");
  });

  test("the ANALYSIS section is omitted when there is no analysis", () => {
    expect(renderText({ ...LOG, analysis: "" }, { errorChars: 4000, requestChars: 4000 })).not.toContain(
      "ANALYSIS",
    );
  });

  test("errorChars truncates the error block but never the analysis", () => {
    const alert: LogAlert = { ...LOG, errorText: "X".repeat(5000) };
    const body = renderText(alert, { errorChars: 800, requestChars: 300 });
    expect(body).toContain("X".repeat(800));
    expect(body).not.toContain("X".repeat(801));
    expect(body).toContain("Likely cause: x");
    expect(body).toContain("LOGS");
  });
});

describe("renderText — accessLog and alarm", () => {
  test("accessLog omits empty detail, requestId and analysis", () => {
    expect(renderText(ACCESS, { errorChars: 4000, requestChars: 4000 })).toBe(
      ["Time: 27/Jul/2026:12:00:00 +0000", "Route: GET /users", "Status: 500"].join(
        "\n",
      ),
    );
  });

  test("accessLog includes every optional field when present", () => {
    const body = renderText(
      {
        ...ACCESS,
        detail: "Internal server error",
        requestId: "req-1",
        analysis: "Likely cause: z",
        silencedCount: 2,
      },
      { errorChars: 4000, requestChars: 4000 },
    );
    expect(body).toContain("Detail: Internal server error");
    expect(body).toContain("Request ID: req-1");
    expect(body).toContain("Recurring: 2 occurrences silenced during cooldown.");
    expect(body).toContain("ANALYSIS");
  });

  test("alarm renders three lines", () => {
    expect(renderText(ALARM, { errorChars: 4000, requestChars: 4000 })).toBe(
      [
        "Time: 2026-07-27T12:00:00.000Z",
        "Resource: Api",
        "Error: HTTP 5xx",
      ].join("\n"),
    );
  });
});

describe("escapeCodeFence", () => {
  test("neutralises backticks so a stack trace cannot break out of a fence", () => {
    expect(escapeCodeFence("a ``` b `c`")).toBe("a ˋˋˋ b ˋcˋ");
    expect(escapeCodeFence("no ticks")).toBe("no ticks");
  });
});

describe("truncate", () => {
  test("leaves short text untouched", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello", 5)).toBe("hello");
  });

  test("appends a marker and never exceeds the budget", () => {
    const out = truncate("Y".repeat(100), 40);
    expect(out.length).toBe(40);
    expect(out.endsWith("… truncated")).toBe(true);
  });

  test("degrades to a hard slice when the budget is tiny", () => {
    expect(truncate("abcdef", 3)).toBe("abc");
    expect(truncate("abcdef", 0)).toBe("");
    expect(truncate("abcdef", -1)).toBe("");
  });
});

describe("webhookMessage", () => {
  test("wraps the subject in bold and the body in a code fence", () => {
    const message = webhookMessage(ALARM, "*", SLACK);
    expect(message).toBe(
      "*[Alert] Api: HTTP 5xx*\n```\n" +
        "Time: 2026-07-27T12:00:00.000Z\nResource: Api\nError: HTTP 5xx" +
        "\n```",
    );
  });

  test("discord uses double asterisks", () => {
    expect(webhookMessage(ALARM, "**", DISCORD).startsWith("**[Alert]")).toBe(
      true,
    );
  });

  test("a huge alert stays under discord's 2000 character limit", () => {
    const alert: LogAlert = {
      ...LOG,
      errorText: "X".repeat(30000),
      sourceFiles: Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`),
      analysis: "Likely cause: x\nSuggested fix: y",
    };
    const message = webhookMessage(alert, "**", DISCORD);
    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message.endsWith("\n```")).toBe(true);
  });

  test("slack keeps the full 3500-char error budget", () => {
    const alert: LogAlert = { ...LOG, errorText: "X".repeat(30000) };
    const message = webhookMessage(alert, "*", SLACK);
    expect(message).toContain("X".repeat(3500));
    expect(message.length).toBeLessThanOrEqual(39000);
  });

  test("the analysis survives even when the error block is squeezed", () => {
    const alert: LogAlert = { ...LOG, errorText: "X".repeat(30000) };
    expect(webhookMessage(alert, "**", DISCORD)).toContain("Likely cause: x");
  });

  test("backticks in the error cannot break out of the fence", () => {
    const alert: LogAlert = {
      ...LOG,
      errorText: "SyntaxError near ```\nmore",
    };
    const message = webhookMessage(alert, "*", SLACK);
    expect(message.split("```").length - 1).toBe(2);
  });

  test("an absurdly long subject cannot overflow the budget", () => {
    const alert: AccessLogAlert = { ...ACCESS, route: `GET /${"p".repeat(5000)}` };
    const message = webhookMessage(alert, "**", DISCORD);
    expect(message.length).toBeLessThanOrEqual(2000);
  });
});

const CTX: RequestContext = {
  method: "POST",
  path: "/v1/migrate",
  requestId: "abc-123",
  sourceIp: "41.13.8.22",
  userAgent: "Mozilla/5.0",
  identity: { sub: "u_8821", email: "jo@acme.io" },
  headers: {
    "content-type": "application/json",
    "x-tenant-id": "acme",
    authorization: "<redacted>",
  },
  body: '{"userId":"u_8821","password":"<redacted>"}',
};

const FULL = { errorChars: 4000, requestChars: 4000 };

describe("renderRequest", () => {
  test("renders every section within a generous budget", () => {
    expect(renderRequest(CTX, 4000).join("\n")).toBe(
      [
        "REQUEST",
        "───────",
        "Method: POST /v1/migrate",
        "Source IP: 41.13.8.22",
        "User agent: Mozilla/5.0",
        "Identity: sub=u_8821, email=jo@acme.io",
        "Headers:",
        "  content-type: application/json",
        "  x-tenant-id: acme",
        "  authorization: <redacted>",
        "Body:",
        '  {"userId":"u_8821","password":"<redacted>"}',
      ].join("\n"),
    );
  });

  test("renders the returned status when present", () => {
    expect(renderRequest({ ...CTX, statusCode: 500 }, 4000)).toContain(
      "Returned: 500",
    );
  });

  test("indents every line of a multi-line body", () => {
    const lines = renderRequest({ method: "GET", body: "one\ntwo" }, 4000);
    expect(lines).toEqual(["REQUEST", "───────", "Method: GET ?", "Body:", "  one", "  two"]);
  });

  test("returns nothing for an empty context or a zero budget", () => {
    expect(renderRequest({}, 4000)).toEqual([]);
    expect(renderRequest({ requestId: "abc" }, 4000)).toEqual([]);
    expect(renderRequest(CTX, 0)).toEqual([]);
  });

  test("drops the body first when over budget", () => {
    const rendered = renderRequest(CTX, 260).join("\n");
    expect(rendered).toContain("Identity: sub=u_8821, email=jo@acme.io");
    expect(rendered).toContain("  content-type: application/json");
    expect(rendered).toContain("<omitted — over channel size limit>");
    expect(rendered).not.toContain('"userId"');
  });

  test("drops header values next, keeping the identifying lines", () => {
    const rendered = renderRequest(CTX, 240).join("\n");
    expect(rendered).toContain("Source IP: 41.13.8.22");
    expect(rendered).toContain("Identity: sub=u_8821, email=jo@acme.io");
    expect(rendered).toContain("  content-type, x-tenant-id, authorization");
    expect(rendered).not.toContain("  content-type: application/json");
  });

  test("falls back to the core lines alone", () => {
    const rendered = renderRequest(CTX, 220).join("\n");
    expect(rendered).toContain("Identity: sub=u_8821, email=jo@acme.io");
    expect(rendered).not.toContain("Headers:");
    expect(rendered).not.toContain("Body:");
  });

  test("truncates when even the core lines do not fit", () => {
    const rendered = renderRequest(CTX, 120).join("\n");
    expect(rendered.length).toBeLessThanOrEqual(120);
    expect(rendered).toContain("truncated");
    expect(rendered.startsWith("REQUEST")).toBe(true);
  });
});

describe("renderText with request context", () => {
  test("log alerts place REQUEST before ERROR and add the request id", () => {
    const body = renderText({ ...LOG, requestContext: CTX }, FULL);
    expect(body).toContain("Request ID: abc-123");
    expect(body.indexOf("REQUEST")).toBeLessThan(body.indexOf("ERROR"));
    expect(body.indexOf("ERROR")).toBeLessThan(body.indexOf("ANALYSIS"));
    expect(body).toContain("Identity: sub=u_8821, email=jo@acme.io");
  });

  test("access-log alerts place REQUEST before ANALYSIS", () => {
    const alert: AccessLogAlert = {
      ...ACCESS,
      analysis: "Likely cause: x",
      requestContext: { sourceIp: "41.13.8.22", identity: { sub: "u_8821" } },
    };
    const body = renderText(alert, FULL);
    expect(body.indexOf("REQUEST")).toBeLessThan(body.indexOf("ANALYSIS"));
    expect(body).toContain("Source IP: 41.13.8.22");
  });

  test("output is byte-identical to today when no request context is present", () => {
    expect(renderText(LOG, FULL)).toBe(renderText({ ...LOG }, FULL));
    expect(renderText(LOG, FULL)).not.toContain("REQUEST");
    expect(renderText(ACCESS, FULL)).not.toContain("REQUEST");
  });
});

describe("webhookMessage with request context", () => {
  const big: LogAlert = {
    ...LOG,
    requestContext: { ...CTX, body: JSON.stringify({ note: "z".repeat(5000) }) },
    errorText: "TypeError: boom\n" + "    at frame\n".repeat(400),
  };

  test("discord stays under the hard 2000-character cap", () => {
    const message = webhookMessage(big, "**", DISCORD);
    expect(message.length).toBeLessThanOrEqual(2000);
  });

  test("discord keeps the identifying lines and the analysis", () => {
    const message = webhookMessage(big, "**", DISCORD);
    expect(message).toContain("Identity: sub=u_8821, email=jo@acme.io");
    expect(message).toContain("Likely cause: x");
    expect(message).not.toContain("zzzzzzzzzz");
  });

  test("slack keeps the full body at its larger budget", () => {
    const message = webhookMessage({ ...LOG, requestContext: CTX }, "*", SLACK);
    expect(message).toContain('"userId":"u_8821"');
  });
});
