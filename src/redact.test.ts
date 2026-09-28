import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  DEFAULT_REDACTION,
  REDACTED,
  clip,
  hasSensitiveShape,
  isAllowedKey,
  isDeniedKey,
  normalizeKey,
  policyFrom,
  redactBody,
  redactHeaders,
  redactRecord,
  redactValue,
} from "./redact.js";

const POLICY = DEFAULT_REDACTION;

describe("normalizeKey", () => {
  test("lowercases and strips separators", () => {
    expect(normalizeKey("X-API_Key")).toBe("xapikey");
    expect(normalizeKey("Content.Type")).toBe("contenttype");
  });
});

describe("isDeniedKey", () => {
  test.each(["Authorization", "X-API-Key", "apiKey", "api_key", "Cookie", "Set-Cookie", "user_password", "refreshToken", "CVV"])(
    "denies %s",
    (key) => {
      expect(isDeniedKey(key, POLICY)).toBe(true);
    },
  );

  test.each(["content-type", "author", "x-tenant-id", "userId", "email", "accept"])(
    "allows %s",
    (key) => {
      expect(isDeniedKey(key, POLICY)).toBe(false);
    },
  );

  test("empty key is not denied", () => {
    expect(isDeniedKey("", POLICY)).toBe(false);
  });

  test("extra keys from policyFrom are honoured", () => {
    const policy = policyFrom({ redact: ["tenant-secret-id", "internalRef"] });
    expect(isDeniedKey("internal_ref", policy)).toBe(true);
    expect(isDeniedKey("x-tenant-id", policy)).toBe(false);
  });
});

describe("policyFrom", () => {
  test("falls back to the default body cap for non-positive input", () => {
    expect(policyFrom({ maxBodyChars: 0 }).maxBodyChars).toBe(POLICY.maxBodyChars);
    expect(policyFrom({ maxBodyChars: -5 }).maxBodyChars).toBe(POLICY.maxBodyChars);
    expect(policyFrom({ maxBodyChars: Number.NaN }).maxBodyChars).toBe(
      POLICY.maxBodyChars,
    );
  });

  test("keeps the default deny list when no extras are given", () => {
    expect(policyFrom().denyKeys).toBe(POLICY.denyKeys);
  });
});

describe("hasSensitiveShape", () => {
  test.each([
    ["bearer token", "Bearer abc.def.ghi"],
    ["basic auth", "Basic dXNlcjpwYXNz"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sIgNaTuRe"],
    ["ssn", "my ssn is 123-45-6789 ok"],
    ["card", "4111 1111 1111 1111"],
    ["card no spaces", "4111111111111111"],
  ])("flags %s", (_label, value) => {
    expect(hasSensitiveShape(value)).toBe(true);
  });

  test.each([
    ["plain text", "something went wrong"],
    ["uuid", "7c4a9b1e-0f3d-4a85-9b2c-1d3e5f7a9b0c"],
    ["short digits", "12345"],
    ["email", "jo@acme.io"],
  ])("does not flag %s", (_label, value) => {
    expect(hasSensitiveShape(value)).toBe(false);
  });
});

describe("clip", () => {
  test("returns text under the cap unchanged", () => {
    expect(clip("hello", 10)).toBe("hello");
  });

  test("appends an ellipsis when over the cap", () => {
    expect(clip("abcdefghij", 5)).toBe("abcd…");
  });

  test("returns empty for a non-positive cap", () => {
    expect(clip("abc", 0)).toBe("");
  });
});

describe("redactValue", () => {
  test("masks denied keys and keeps the rest", () => {
    const out = redactValue(
      { userId: "u_8821", email: "jo@acme.io", password: "hunter2" },
      POLICY,
    );
    expect(out).toEqual({
      userId: "u_8821",
      email: "jo@acme.io",
      password: REDACTED,
    });
  });

  test("walks nested objects and arrays", () => {
    const out = redactValue(
      { user: { id: 1, apiKey: "sk-live-xyz" }, items: [{ token: "t" }, "ok"] },
      POLICY,
    );
    expect(out).toEqual({
      user: { id: 1, apiKey: REDACTED },
      items: [{ token: REDACTED }, "ok"],
    });
  });

  test("masks sensitive-shaped values even under an allowed key", () => {
    const out = redactValue({ note: "Bearer sk-live-xyz" }, POLICY);
    expect(out).toEqual({ note: REDACTED });
  });

  test("caps array length", () => {
    const out = redactValue(Array.from({ length: 25 }, (_v, i) => i), POLICY);
    expect(Array.isArray(out)).toBe(true);
    const items = out as unknown[];
    expect(items).toHaveLength(POLICY.maxArrayItems + 1);
    expect(items[POLICY.maxArrayItems]).toBe("<5 more items>");
  });

  test("caps depth", () => {
    let deep: Record<string, unknown> = { leaf: "value" };
    for (let i = 0; i < 10; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redactValue(deep, POLICY))).toContain("<depth limit>");
  });

  test("survives cycles", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    expect(redactValue(node, POLICY)).toEqual({
      name: "root",
      self: "<circular>",
    });
  });

  test("does not treat a repeated sibling reference as a cycle", () => {
    const shared = { id: 1 };
    expect(redactValue({ a: shared, b: shared }, POLICY)).toEqual({
      a: { id: 1 },
      b: { id: 1 },
    });
  });

  test("passes primitives through", () => {
    expect(redactValue(42, POLICY)).toBe(42);
    expect(redactValue(null, POLICY)).toBe(null);
    expect(redactValue(true, POLICY)).toBe(true);
  });
});

describe("redactRecord", () => {
  test("redacts an access-log shaped entry", () => {
    expect(
      redactRecord({ routeKey: "GET /x", status: 500, authorization: "abc" }, POLICY),
    ).toEqual({ routeKey: "GET /x", status: 500, authorization: REDACTED });
  });
});

describe("redactHeaders", () => {
  test("lowercases names, masks denied ones, drops undefined", () => {
    expect(
      redactHeaders(
        {
          "Content-Type": "application/json",
          "X-Tenant-Id": "acme",
          Authorization: "Bearer abc",
          Cookie: "session=1",
          "X-Missing": undefined,
        },
        POLICY,
      ),
    ).toEqual({
      "content-type": "application/json",
      "x-tenant-id": "acme",
      authorization: REDACTED,
      cookie: REDACTED,
    });
  });

  test("masks a sensitive-shaped value under an allowed header name", () => {
    expect(redactHeaders({ "x-forwarded-auth": "Bearer abc" }, POLICY)).toEqual({
      "x-forwarded-auth": REDACTED,
    });
  });

  test("returns an empty object for undefined headers", () => {
    expect(redactHeaders(undefined, POLICY)).toEqual({});
  });
});

describe("redactBody", () => {
  test("returns undefined for empty input", () => {
    expect(redactBody(undefined, false, POLICY)).toBeUndefined();
    expect(redactBody("", false, POLICY)).toBeUndefined();
    expect(redactBody("   ", false, POLICY)).toBeUndefined();
  });

  test("redacts JSON bodies by key", () => {
    expect(
      redactBody('{"userId":"u_8821","password":"hunter2"}', false, POLICY),
    ).toBe('{"userId":"u_8821","password":"<redacted>"}');
  });

  test("redacts JSON array bodies", () => {
    expect(redactBody('[{"token":"t"}]', false, POLICY)).toBe(
      '[{"token":"<redacted>"}]',
    );
  });

  test("decodes base64 bodies before redacting", () => {
    const encoded = Buffer.from('{"apiKey":"sk-1"}', "utf-8").toString("base64");
    expect(redactBody(encoded, true, POLICY)).toBe('{"apiKey":"<redacted>"}');
  });

  test("reports binary base64 bodies by size", () => {
    const encoded = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]).toString("base64");
    expect(redactBody(encoded, true, POLICY)).toBe("<binary, 5 bytes>");
  });

  test("redacts form-encoded bodies by param name", () => {
    expect(redactBody("user=jo&password=hunter2", false, POLICY)).toBe(
      "user=jo&password=<redacted>",
    );
  });

  test("masks an opaque body that looks sensitive", () => {
    expect(redactBody("Bearer sk-live-abc", false, POLICY)).toBe(REDACTED);
  });

  test("keeps an opaque body that looks harmless", () => {
    expect(redactBody("plain text payload", false, POLICY)).toBe(
      "plain text payload",
    );
  });

  test("falls back to opaque handling for malformed JSON", () => {
    expect(redactBody('{"broken":', false, POLICY)).toBe('{"broken":');
  });

  test("truncates to maxBodyChars", () => {
    const policy = policyFrom({ maxBodyChars: 20 });
    const out = redactBody("x".repeat(500), false, policy);
    expect(out).toHaveLength(20);
    expect(out?.endsWith("…")).toBe(true);
  });
});

describe("redact: false disables redaction entirely", () => {
  const OFF = policyFrom({ redact: false });

  test("the policy reports itself disabled", () => {
    expect(OFF.enabled).toBe(false);
    expect(policyFrom().enabled).toBe(true);
  });

  test("denied keys pass through", () => {
    expect(isDeniedKey("authorization", OFF)).toBe(false);
    expect(
      redactHeaders({ Authorization: "Bearer abc", Cookie: "sid=1" }, OFF),
    ).toEqual({ authorization: "Bearer abc", cookie: "sid=1" });
  });

  test("sensitive-shaped values pass through", () => {
    expect(redactValue({ note: "Bearer sk-live-xyz" }, OFF)).toEqual({
      note: "Bearer sk-live-xyz",
    });
  });

  test("JSON bodies pass through", () => {
    expect(
      redactBody('{"refresh_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"}', false, OFF),
    ).toBe('{"refresh_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"}');
  });

  test("form-encoded bodies pass through", () => {
    expect(redactBody("user=jo&password=hunter2", false, OFF)).toBe(
      "user=jo&password=hunter2",
    );
  });

  test("opaque bodies pass through", () => {
    expect(redactBody("Bearer sk-live-abc", false, OFF)).toBe("Bearer sk-live-abc");
  });

  test("size and depth caps still apply", () => {
    const capped = policyFrom({ redact: false, maxBodyChars: 20 });
    expect(redactBody("x".repeat(500), false, capped)).toHaveLength(20);
    expect(
      (redactValue(Array.from({ length: 25 }, (_v, i) => i), OFF) as unknown[]),
    ).toHaveLength(OFF.maxArrayItems + 1);
  });

  test("extra redact terms are ignored when disabled", () => {
    expect(isDeniedKey("x-tenant-id", policyFrom({ redact: false }))).toBe(false);
  });
});

describe("allow un-redacts specific keys", () => {
  const ALLOW = policyFrom({ allow: ["refresh_token", "authorization"] });

  test("an allowed key survives the deny list", () => {
    expect(isDeniedKey("refresh_token", ALLOW)).toBe(false);
    expect(isDeniedKey("refreshToken", ALLOW)).toBe(false);
    expect(isAllowedKey("REFRESH-TOKEN", ALLOW)).toBe(true);
  });

  test("an allowed key also bypasses value-shape masking", () => {
    expect(
      redactBody(
        '{"refresh_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig","password":"p"}',
        false,
        ALLOW,
      ),
    ).toBe(
      '{"refresh_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig","password":"<redacted>"}',
    );
  });

  test("an allowed header keeps its value while others are masked", () => {
    expect(
      redactHeaders({ Authorization: "Bearer abc", Cookie: "sid=1" }, ALLOW),
    ).toEqual({ authorization: "Bearer abc", cookie: REDACTED });
  });

  test("an allowed form field keeps its value", () => {
    expect(redactBody("refresh_token=abc.def&password=p", false, ALLOW)).toBe(
      "refresh_token=abc.def&password=<redacted>",
    );
  });

  test("allow matches the whole key, not a substring", () => {
    const policy = policyFrom({ allow: ["token"] });
    expect(isDeniedKey("token", policy)).toBe(false);
    expect(isDeniedKey("api_token", policy)).toBe(true);
  });

  test("everything else keeps its default treatment", () => {
    expect(isDeniedKey("password", ALLOW)).toBe(true);
    expect(isAllowedKey("password", ALLOW)).toBe(false);
  });
});
