import { describe, expect, test } from "bun:test";
import {
  accessLogFormat,
  accessLogRequestContext,
  buildAccessLogFormat,
  numberOrUndefined,
  presentString,
  type AccessLogStageArgs,
} from "./access-log.js";
import { DEFAULT_REDACTION } from "./redact.js";

const SST_DEFAULT_KEYS = [
  "requestTime",
  "requestId",
  "httpMethod",
  "path",
  "routeKey",
  "status",
  "responseLatency",
  "integrationRequestId",
  "integrationStatus",
  "integrationLatency",
  "integrationServiceStatus",
  "ip",
  "userAgent",
];

function parsed(format: string): Record<string, string> {
  return JSON.parse(format) as Record<string, string>;
}

describe("buildAccessLogFormat", () => {
  test("produces valid JSON", () => {
    expect(() => parsed(buildAccessLogFormat())).not.toThrow();
  });

  test.each(SST_DEFAULT_KEYS)("keeps SST's default key %s", (key) => {
    expect(parsed(buildAccessLogFormat())).toHaveProperty(key);
  });

  test("matches SST's quoting convention", () => {
    const fields = parsed(buildAccessLogFormat());
    expect(fields.requestId).toBe('"$context.requestId"');
    expect(fields.ip).toBe('"$context.identity.sourceIp"');
  });

  test("leaves numeric fields unquoted so they parse as numbers", () => {
    const fields = parsed(buildAccessLogFormat());
    expect(fields.status).toBe("$context.status");
    expect(fields.responseLatency).toBe("$context.responseLatency");
    expect(fields.responseLength).toBe("$context.responseLength");
  });

  test("adds the identity and error fields SST omits", () => {
    const fields = parsed(buildAccessLogFormat());
    expect(fields.errorMessage).toBe('"$context.error.message"');
    expect(fields.integrationErrorMessage).toBe('"$context.integrationErrorMessage"');
    expect(fields.iamUser).toBe('"$context.identity.user"');
    expect(fields.authPrincipalId).toBe('"$context.authorizer.principalId"');
  });

  test("uses the default JWT claims when none are named", () => {
    const fields = parsed(buildAccessLogFormat());
    expect(fields.authSub).toBe('"$context.authorizer.claims.sub"');
    expect(fields.authEmail).toBe('"$context.authorizer.claims.email"');
    expect(fields.authUsername).toBe('"$context.authorizer.claims.username"');
  });

  test("named claims replace the defaults under the auth_ prefix", () => {
    const fields = parsed(buildAccessLogFormat({ authorizerClaims: ["sub", "org_id"] }));
    expect(fields.auth_sub).toBe('"$context.authorizer.claims.sub"');
    expect(fields.auth_org_id).toBe('"$context.authorizer.claims.org_id"');
    expect(fields.authSub).toBeUndefined();
  });

  test("lambda authorizer context keys map to $context.authorizer.<key>", () => {
    const fields = parsed(
      buildAccessLogFormat({ authorizerContext: ["userId", "orgId"] }),
    );
    expect(fields.auth_userId).toBe('"$context.authorizer.userId"');
    expect(fields.auth_orgId).toBe('"$context.authorizer.orgId"');
  });

  test("an emitted line survives the notifier's quote stripping", () => {
    const substitutions: Record<string, string> = {
      "$context.identity.sourceIp": "41.13.8.22",
      "$context.status": "500",
      "$context.authorizer.claims.sub": "u_8821",
      "$context.authorizer.claims.email": "-",
    };
    const template = parsed(buildAccessLogFormat());
    const emitted: Record<string, string> = {};
    for (const [key, value] of Object.entries(template)) {
      emitted[key] = Object.entries(substitutions).reduce(
        (acc, [variable, replacement]) => acc.split(variable).join(replacement),
        value,
      );
    }

    const strip = (value: string) => value.replace(/^"|"$/g, "");
    expect(strip(emitted.ip)).toBe("41.13.8.22");
    expect(Number(strip(emitted.status))).toBe(500);
    expect(strip(emitted.authSub)).toBe("u_8821");
    expect(strip(emitted.authEmail)).toBe("-");
  });
});

describe("accessLogFormat", () => {
  test("sets the format on the stage args", () => {
    const args: AccessLogStageArgs = {};
    accessLogFormat()(args);
    expect(typeof args.accessLogSettings?.format).toBe("string");
  });

  test("preserves an existing destinationArn", () => {
    const args: AccessLogStageArgs = {
      accessLogSettings: { destinationArn: "arn:aws:logs:eu-west-1:1:log-group:x" },
    };
    accessLogFormat()(args);
    expect(args.accessLogSettings?.destinationArn).toBe(
      "arn:aws:logs:eu-west-1:1:log-group:x",
    );
  });

  test("overwrites a previously set format", () => {
    const args: AccessLogStageArgs = {
      accessLogSettings: { destinationArn: "arn", format: "old" },
    };
    accessLogFormat()(args);
    expect(args.accessLogSettings?.format).not.toBe("old");
  });

  test("passes custom fields through", () => {
    const args: AccessLogStageArgs = {};
    accessLogFormat({ authorizerContext: ["userId"] })(args);
    expect(String(args.accessLogSettings?.format)).toContain(
      "$context.authorizer.userId",
    );
  });
});

describe("presentString", () => {
  test.each([
    ["41.13.8.22", "41.13.8.22"],
    ["  acme  ", "acme"],
  ])("keeps %s", (input, expected) => {
    expect(presentString(input)).toBe(expected);
  });

  test.each(["-", "", "   "])("drops the unresolved value %p", (input) => {
    expect(presentString(input)).toBeUndefined();
  });

  test("stringifies finite numbers and drops everything else", () => {
    expect(presentString(500)).toBe("500");
    expect(presentString(Number.NaN)).toBeUndefined();
    expect(presentString(null)).toBeUndefined();
    expect(presentString(undefined)).toBeUndefined();
    expect(presentString({ a: 1 })).toBeUndefined();
  });
});

describe("numberOrUndefined", () => {
  test("parses numeric strings and numbers", () => {
    expect(numberOrUndefined("4312")).toBe(4312);
    expect(numberOrUndefined(12)).toBe(12);
  });

  test("rejects non-numeric input", () => {
    expect(numberOrUndefined("-")).toBeUndefined();
    expect(numberOrUndefined(undefined)).toBeUndefined();
    expect(numberOrUndefined("abc")).toBeUndefined();
  });
});

describe("accessLogRequestContext", () => {
  const POLICY = DEFAULT_REDACTION;

  test("maps the fields SST already logs", () => {
    expect(
      accessLogRequestContext({ ip: "41.13.8.22", userAgent: "curl/8.0" }, POLICY),
    ).toEqual({ sourceIp: "41.13.8.22", userAgent: "curl/8.0" });
  });

  test("maps the default JWT claim fields to identity", () => {
    expect(
      accessLogRequestContext(
        {
          ip: "41.13.8.22",
          authSub: "u_8821",
          authEmail: "jo@acme.io",
          authUsername: "jo",
        },
        POLICY,
      ),
    ).toEqual({
      sourceIp: "41.13.8.22",
      identity: { sub: "u_8821", email: "jo@acme.io", username: "jo" },
    });
  });

  test("maps IAM, Cognito and principal identities", () => {
    expect(
      accessLogRequestContext(
        {
          authPrincipalId: "p_1",
          cognitoIdentityId: "eu-west-1:abc",
          iamUser: "AIDAEXAMPLE",
        },
        POLICY,
      )?.identity,
    ).toEqual({
      principalId: "p_1",
      cognitoId: "eu-west-1:abc",
      iamUser: "AIDAEXAMPLE",
    });
  });

  test("maps custom auth_ fields by stripping the prefix", () => {
    expect(
      accessLogRequestContext({ auth_userId: "u_77", auth_org_id: "o_3" }, POLICY)
        ?.identity,
    ).toEqual({ userId: "u_77", org_id: "o_3" });
  });

  test("drops unresolved authorizer placeholders", () => {
    expect(
      accessLogRequestContext(
        { ip: "41.13.8.22", authSub: "-", authEmail: "", auth_userId: "-" },
        POLICY,
      ),
    ).toEqual({ sourceIp: "41.13.8.22" });
  });

  test("redacts a sensitive identity value", () => {
    expect(
      accessLogRequestContext({ auth_apiKey: "sk-live-x" }, POLICY)?.identity,
    ).toEqual({ apiKey: "<redacted>" });
  });

  test("returns undefined when nothing identifying is present", () => {
    expect(accessLogRequestContext({ status: 500, routeKey: "GET /x" }, POLICY))
      .toBeUndefined();
    expect(accessLogRequestContext({ ip: "-", userAgent: "-" }, POLICY))
      .toBeUndefined();
  });

  test("consumes a line emitted by buildAccessLogFormat", () => {
    const substitutions: Record<string, string> = {
      "$context.identity.sourceIp": "41.13.8.22",
      "$context.identity.userAgent": "Mozilla/5.0",
      "$context.authorizer.claims.sub": "u_8821",
      "$context.authorizer.claims.email": "jo@acme.io",
      "$context.authorizer.claims.username": "-",
      "$context.authorizer.principalId": "-",
      "$context.identity.user": "-",
      "$context.status": "500",
    };
    const template = parsed(buildAccessLogFormat());
    const entry: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      const substituted = Object.entries(substitutions).reduce(
        (acc, [variable, replacement]) => acc.split(variable).join(replacement),
        value,
      );
      entry[key] = substituted.replace(/^"|"$/g, "");
    }

    expect(accessLogRequestContext(entry, POLICY)).toEqual({
      sourceIp: "41.13.8.22",
      userAgent: "Mozilla/5.0",
      identity: { sub: "u_8821", email: "jo@acme.io" },
    });
  });
});
