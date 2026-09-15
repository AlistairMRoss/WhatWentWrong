import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { captureRequest } from "./capture.js";
import { REDACTED } from "./redact.js";
import { tryParseRequestContext } from "./runtime/request-context.js";

const originalError = console.error;
let lines: string[] = [];

function trap(): void {
  lines = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
}

afterEach(() => {
  console.error = originalError;
});

function captured() {
  const parsed = lines
    .map((line) => tryParseRequestContext(line))
    .filter((ctx) => ctx !== null);
  return parsed;
}

const EVENT = {
  version: "2.0",
  rawPath: "/v1/migrate",
  rawQueryString: "dry=1",
  isBase64Encoded: false,
  body: '{"userId":"u_8821","password":"hunter2"}',
  headers: {
    "content-type": "application/json",
    "x-tenant-id": "acme",
    authorization: "Bearer sk-live-abc",
    "user-agent": "Mozilla/5.0",
  },
  requestContext: {
    requestId: "abc-123",
    http: {
      method: "POST",
      path: "/v1/migrate",
      sourceIp: "41.13.8.22",
      userAgent: "Mozilla/5.0",
    },
    authorizer: {
      jwt: { claims: { sub: "u_8821", email: "jo@acme.io", scope: ["a", "b"] } },
    },
  },
};

describe("captureRequest throw path", () => {
  test("emits one context line and rethrows the original error", async () => {
    trap();
    const boom = new Error("boom");
    const wrapped = captureRequest(async () => {
      throw boom;
    });
    await expect(wrapped(EVENT)).rejects.toBe(boom);

    const ctx = captured();
    expect(ctx).toHaveLength(1);
    expect(ctx[0]).toMatchObject({
      method: "POST",
      path: "/v1/migrate?dry=1",
      requestId: "abc-123",
      sourceIp: "41.13.8.22",
      userAgent: "Mozilla/5.0",
    });
  });

  test("redacts denied headers, body fields and claims", async () => {
    trap();
    const wrapped = captureRequest(async () => {
      throw new Error("boom");
    });
    await expect(wrapped(EVENT)).rejects.toThrow("boom");

    const ctx = captured()[0];
    expect(ctx?.headers).toEqual({
      "content-type": "application/json",
      "x-tenant-id": "acme",
      authorization: REDACTED,
      "user-agent": "Mozilla/5.0",
    });
    expect(ctx?.body).toBe('{"userId":"u_8821","password":"<redacted>"}');
    expect(ctx?.identity).toEqual({ sub: "u_8821", email: "jo@acme.io" });
  });

  test("emits exactly one line", async () => {
    trap();
    const wrapped = captureRequest(async () => {
      throw new Error("boom");
    });
    await expect(wrapped(EVENT)).rejects.toThrow("boom");
    expect(lines).toHaveLength(1);
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(lines[0]).toContain("ERROR");
  });

  test("rethrows non-Error throwables unchanged", async () => {
    trap();
    const wrapped = captureRequest(async () => {
      throw "a string";
    });
    await expect(wrapped(EVENT)).rejects.toBe("a string");
    expect(captured()).toHaveLength(1);
  });

  test("supports a synchronous handler", async () => {
    trap();
    const wrapped = captureRequest(() => {
      throw new Error("sync boom");
    });
    await expect(wrapped(EVENT)).rejects.toThrow("sync boom");
    expect(captured()).toHaveLength(1);
  });
});

describe("captureRequest status path", () => {
  test("captures a 4xx returned without throwing", async () => {
    trap();
    const response = { statusCode: 400, body: "bad request" };
    const wrapped = captureRequest(async () => response);
    await expect(wrapped(EVENT)).resolves.toBe(response);
    expect(captured()[0]?.statusCode).toBe(400);
  });

  test("captures a 500 returned from a swallowing try/catch", async () => {
    trap();
    const wrapped = captureRequest(async () => ({ statusCode: 500 }));
    await wrapped(EVENT);
    expect(captured()[0]?.statusCode).toBe(500);
  });

  test("stays silent on a 2xx", async () => {
    trap();
    const wrapped = captureRequest(async () => ({ statusCode: 200 }));
    await wrapped(EVENT);
    expect(lines).toHaveLength(0);
  });

  test("honours a raised captureStatusFrom", async () => {
    trap();
    const wrapped = captureRequest(async () => ({ statusCode: 404 }), {
      captureStatusFrom: 500,
    });
    await wrapped(EVENT);
    expect(lines).toHaveLength(0);
  });

  test("captureStatusFrom Infinity disables the status path but keeps the throw path", async () => {
    trap();
    const noStatus = captureRequest(async () => ({ statusCode: 500 }), {
      captureStatusFrom: Number.POSITIVE_INFINITY,
    });
    await noStatus(EVENT);
    expect(lines).toHaveLength(0);

    const thrower = captureRequest(
      async () => {
        throw new Error("boom");
      },
      { captureStatusFrom: Number.POSITIVE_INFINITY },
    );
    await expect(thrower(EVENT)).rejects.toThrow("boom");
    expect(captured()).toHaveLength(1);
  });

  test("ignores a non-numeric statusCode", async () => {
    trap();
    const wrapped = captureRequest(async () => ({ statusCode: "500" }));
    await wrapped(EVENT);
    expect(lines).toHaveLength(0);
  });

  test("ignores a non-object result", async () => {
    trap();
    const wrapped = captureRequest(async () => "plain string");
    await expect(wrapped(EVENT)).resolves.toBe("plain string");
    expect(lines).toHaveLength(0);
  });
});

describe("captureRequest options", () => {
  test("headers: false omits the header map", async () => {
    trap();
    const wrapped = captureRequest(
      async () => {
        throw new Error("boom");
      },
      { headers: false },
    );
    await expect(wrapped(EVENT)).rejects.toThrow("boom");
    expect(captured()[0]?.headers).toBeUndefined();
    expect(captured()[0]?.body).toBeDefined();
  });

  test("body: false omits the body", async () => {
    trap();
    const wrapped = captureRequest(
      async () => {
        throw new Error("boom");
      },
      { body: false },
    );
    await expect(wrapped(EVENT)).rejects.toThrow("boom");
    expect(captured()[0]?.body).toBeUndefined();
    expect(captured()[0]?.headers).toBeDefined();
  });

  test("extra redact keys are applied", async () => {
    trap();
    const wrapped = captureRequest(
      async () => {
        throw new Error("boom");
      },
      { redact: ["x-tenant-id"] },
    );
    await expect(wrapped(EVENT)).rejects.toThrow("boom");
    expect(captured()[0]?.headers?.["x-tenant-id"]).toBe(REDACTED);
  });

  test("maxBodyChars truncates the body", async () => {
    trap();
    const big = { ...EVENT, body: JSON.stringify({ note: "x".repeat(5000) }) };
    const wrapped = captureRequest(
      async () => {
        throw new Error("boom");
      },
      { maxBodyChars: 50 },
    );
    await expect(wrapped(big)).rejects.toThrow("boom");
    expect(captured()[0]?.body?.length).toBe(50);
  });
});

describe("captureRequest non-HTTP events", () => {
  test("omits the block entirely for an SQS event with no lambda context", async () => {
    trap();
    const wrapped = captureRequest(async () => {
      throw new Error("boom");
    });
    await expect(
      wrapped({ Records: [{ messageId: "m1", body: "job" }] }),
    ).rejects.toThrow("boom");
    expect(lines).toHaveLength(0);
  });

  test("omits the block for a cron event", async () => {
    trap();
    const wrapped = captureRequest(async () => {
      throw new Error("boom");
    });
    await expect(
      wrapped({ source: "aws.events" }, { awsRequestId: "ctx-1" }),
    ).rejects.toThrow("boom");
    expect(lines).toHaveLength(0);
  });

  test("tolerates a null event", async () => {
    trap();
    const wrapped = captureRequest(async () => {
      throw new Error("boom");
    });
    await expect(wrapped(null)).rejects.toThrow("boom");
    expect(lines).toHaveLength(0);
  });
});

describe("captureRequest robustness", () => {
  test("falls back to the lambda context request id", async () => {
    trap();
    const event = { ...EVENT, requestContext: { http: { method: "GET", path: "/x" } } };
    const wrapped = captureRequest(async () => {
      throw new Error("boom");
    });
    await expect(wrapped(event, { awsRequestId: "ctx-9" })).rejects.toThrow("boom");
    expect(captured()[0]?.requestId).toBe("ctx-9");
  });

  test("reads the user agent from headers when http.userAgent is absent", async () => {
    trap();
    const event = {
      headers: { "User-Agent": "curl/8.0" },
      requestContext: { http: { method: "GET", path: "/x" } },
    };
    const wrapped = captureRequest(async () => {
      throw new Error("boom");
    });
    await expect(wrapped(event)).rejects.toThrow("boom");
    expect(captured()[0]?.userAgent).toBe("curl/8.0");
  });

  test("decodes a base64 body", async () => {
    trap();
    const event = {
      ...EVENT,
      isBase64Encoded: true,
      body: Buffer.from('{"apiKey":"sk-1"}', "utf-8").toString("base64"),
    };
    const wrapped = captureRequest(async () => {
      throw new Error("boom");
    });
    await expect(wrapped(event)).rejects.toThrow("boom");
    expect(captured()[0]?.body).toBe('{"apiKey":"<redacted>"}');
  });

  test("a serialisation failure inside the wrapper does not affect the handler", async () => {
    trap();
    const hostile = {
      ...EVENT,
      get headers(): never {
        throw new Error("hostile getter");
      },
    };
    const boom = new Error("boom");
    const wrapped = captureRequest(async () => {
      throw boom;
    });
    await expect(wrapped(hostile)).rejects.toBe(boom);
    expect(lines).toHaveLength(0);
  });

  test("a serialisation failure does not affect a successful result", async () => {
    trap();
    const hostile = {
      ...EVENT,
      get headers(): never {
        throw new Error("hostile getter");
      },
    };
    const response = { statusCode: 500 };
    const wrapped = captureRequest(async () => response);
    await expect(wrapped(hostile)).resolves.toBe(response);
  });

  test("handles a lambda authorizer context map and principalId", async () => {
    trap();
    const event = {
      ...EVENT,
      requestContext: {
        requestId: "abc-123",
        http: { method: "POST", path: "/v1/migrate" },
        authorizer: {
          principalId: "p_1",
          lambda: { userId: "u_77", orgId: "o_3", apiKey: "sk-live-x" },
        },
      },
    };
    const wrapped = captureRequest(async () => {
      throw new Error("boom");
    });
    await expect(wrapped(event)).rejects.toThrow("boom");
    expect(captured()[0]?.identity).toEqual({
      userId: "u_77",
      orgId: "o_3",
      apiKey: REDACTED,
      principalId: "p_1",
    });
  });
});

describe("captureRequest redaction control", () => {
  const AUTH_EVENT = {
    rawPath: "/auth/refresh",
    headers: {
      "content-type": "application/json",
      cookie: "sid=abc; refresh_token=rt_9f2c",
      authorization: "Bearer sk-live-abc",
    },
    body: JSON.stringify({ refresh_token: "rt_9f2c", deviceId: "d_1" }),
    requestContext: {
      requestId: "Du1njj94joEEJCA=",
      http: { method: "POST", path: "/auth/refresh", sourceIp: "41.13.8.22" },
    },
  };

  test("redact: false emits headers and body verbatim", async () => {
    trap();
    const wrapped = captureRequest(async () => ({ statusCode: 401 }), {
      redact: false,
    });
    await wrapped(AUTH_EVENT);
    const ctx = captured()[0];
    expect(ctx?.headers?.cookie).toBe("sid=abc; refresh_token=rt_9f2c");
    expect(ctx?.headers?.authorization).toBe("Bearer sk-live-abc");
    expect(ctx?.body).toBe('{"refresh_token":"rt_9f2c","deviceId":"d_1"}');
  });

  test("allow reveals one field and keeps the rest masked", async () => {
    trap();
    const wrapped = captureRequest(async () => ({ statusCode: 401 }), {
      allow: ["refresh_token"],
    });
    await wrapped(AUTH_EVENT);
    const ctx = captured()[0];
    expect(ctx?.body).toBe('{"refresh_token":"rt_9f2c","deviceId":"d_1"}');
    expect(ctx?.headers?.authorization).toBe(REDACTED);
    expect(ctx?.headers?.cookie).toBe(REDACTED);
  });

  test("the default still masks everything sensitive", async () => {
    trap();
    const wrapped = captureRequest(async () => ({ statusCode: 401 }));
    await wrapped(AUTH_EVENT);
    const ctx = captured()[0];
    expect(ctx?.body).toBe('{"refresh_token":"<redacted>","deviceId":"d_1"}');
    expect(ctx?.headers?.cookie).toBe(REDACTED);
  });

  test("WWW_REDACT=off disables redaction when no option is given", async () => {
    const previous = process.env.WWW_REDACT;
    process.env.WWW_REDACT = "off";
    try {
      trap();
      const wrapped = captureRequest(async () => ({ statusCode: 401 }));
      await wrapped(AUTH_EVENT);
      expect(captured()[0]?.headers?.authorization).toBe("Bearer sk-live-abc");
    } finally {
      if (previous === undefined) delete process.env.WWW_REDACT;
      else process.env.WWW_REDACT = previous;
    }
  });

  test("an explicit redact option beats WWW_REDACT=off", async () => {
    const previous = process.env.WWW_REDACT;
    process.env.WWW_REDACT = "off";
    try {
      trap();
      const wrapped = captureRequest(async () => ({ statusCode: 401 }), {
        redact: [],
      });
      await wrapped(AUTH_EVENT);
      expect(captured()[0]?.headers?.authorization).toBe(REDACTED);
    } finally {
      if (previous === undefined) delete process.env.WWW_REDACT;
      else process.env.WWW_REDACT = previous;
    }
  });
});
