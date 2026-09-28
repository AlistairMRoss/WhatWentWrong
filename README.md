# whatwentwrong

Drop-in error alerting for [SST v3 (ion)](https://sst.dev) projects. Add it to your stack, point it at the resources you care about, and get an email, Slack message or Discord message the moment something throws — optionally with an AI-generated cause-and-fix included in the body.

```ts
const alerts = new Monitor("Alerts", { email: "you@example.com" });
alerts.watch([api, queue, cron]);
```

That's the whole minimum setup. No CloudWatch dashboards to wire, no SNS topic to remember, no IAM policies to write.

## Install

```bash
npm install whatwentwrong
# or
pnpm add whatwentwrong
# or
yarn add whatwentwrong
# or
bun add whatwentwrong
```

Peer dependencies (already in any SST v3 project): `sst`, `@pulumi/aws`, `@pulumi/pulumi`.

## Quickstart

```ts
export default $config({
  app(input) {
    return {
      name: "my-app",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    const { Monitor } = await import("whatwentwrong");

    const alerts = new Monitor("Alerts", {
      email: "you@example.com",
    });

    const api = new sst.aws.Function("Api", {
      handler: "src/api.handler",
      url: true,
    });
    const httpApi = new sst.aws.ApiGatewayV2("HttpApi");
    const queue = new sst.aws.Queue("Jobs");
    const cron = new sst.aws.Cron("Daily", {
      schedule: "rate(1 day)",
      job: "src/cron.handler",
    });

    alerts.watch([api, httpApi, queue, cron]);
  },
});
```

**Heads up — dynamic import is required.** SST v3 disallows top-level imports in `sst.config.ts`, so always load this package via `await import("whatwentwrong")` inside `run()`. A top-level `import { Monitor } from "whatwentwrong"` will fail with "top level imports — this is not allowed."

After your first `sst deploy`, AWS sends a confirmation email to each address you subscribed. Click the link once — alerts start landing immediately.

## Supported resources

`Monitor.watch()` accepts a single resource or an array. The right alarm shape is picked automatically based on the resource type.

| Resource                       | Signal                                       | Default trigger          |
| ------------------------------ | -------------------------------------------- | ------------------------ |
| `sst.aws.Function`             | CloudWatch Logs match on `ERROR`, `Exception`, `Task timed out`, `Unhandled` | 1+ in any 60s window     |
| `sst.aws.Cron`                 | Same as Function (watches the underlying handler)                            | 1+ in any 60s window     |
| `sst.aws.ApiGatewayV2`         | Access logs if enabled (per-request `4xx`/`5xx`); otherwise the API Gateway metric. **Every route attached to the API is auto-watched** — its own function-log path (stack trace) and source context activate without any extra code. | 1+ in any 60s window |
| `sst.aws.Queue` (SQS)          | `ApproximateAgeOfOldestMessage`              | greater than 300 seconds |

### How API Gateway gets full AI context automatically

```ts
const alerts = new Monitor("Alerts", {
  email: "you@example.com",
  ai: { provider: "anthropic" },
  sourceContext: true,
});

const api = new sst.aws.ApiGatewayV2("Api");
api.route("GET /v1/test", "src/handlers/test.handler");
api.route("POST /v1/migrate", "src/handlers/auth/migrate.handler");

alerts.watch([api]);   // ← watches the API and every route attached to it
```

`Monitor` patches `sst.aws.ApiGatewayV2.prototype.route` the first time you construct one, so every `api.route(...)` (and any helper that calls it, like a custom `addAuthRoute`) is recorded. When you call `alerts.watch(api)`:

- The API's access log gets a subscription filter for 4xx/5xx (or the API Gateway metric if access logs are disabled).
- Every route's **backing function log group** gets a subscription too — so a real stack trace flows in when the function logs the error. This requires request context to be enabled (the default); with `requestContext: false` only the access-log path is subscribed, so route alerts carry no stack trace.
- With `sourceContext: true`, each route's handler source (plus its import graph) is uploaded, **plus** a route → bundle index file is written. The notifier uses the index on access-log alerts to pull the handler's original source and feed it to the AI — so the AI reasons about the actual handler code even if the function silently swallowed the error.

**Important caveat** — for a stack trace to appear, the function has to log the error. If your handler does:

```ts
try { ... } catch (err) { return { statusCode: 500, ... } }
```

CloudWatch sees nothing (no `ERROR`/`Exception` keyword to match). The function-log path can't fire. The access-log path still fires, and with `sourceContext: true` the AI gets the handler source — but the most informative alerts come from `console.error(err)` in your catch block, which lets the function-log path pick up the actual stack trace.

Wrapping the handler in [`captureRequest`](#path-2--the-handler-wrapper-headers-and-body) closes this gap without a `console.error`: it detects the returned 4xx/5xx and emits the request context itself.

Anything else throws at deploy time with a clear error.

For a dead-letter queue, just `.watch()` it like any other queue — the age threshold catches messages that have been sitting unread.

## Per-watch overrides

If a default doesn't fit, pass an options bag as the second argument.

```ts
alerts.watch(api, {
  pattern: '{ $.level = "error" }',
  threshold: 5,
  period: 300,
});
```

| Option       | Applies to            | Description                                                            |
| ------------ | --------------------- | ---------------------------------------------------------------------- |
| `pattern`    | Function, Cron        | CloudWatch Logs filter pattern. Plain text, JSON, or quoted phrases.   |
| `threshold`  | all                   | Threshold for the alarm. Default 1 for error counts, 300 for queue age.|
| `period`     | all                   | Evaluation window in seconds. Default 60.                              |
| `metric`     | ApiGatewayV2          | A matcher or array of matchers. Default `"5xx"`. See below.            |

A `metric` matcher is one of:

- **Class wildcard** — `"4xx"`, `"5xx"` (any code in that hundred).
- **Exact code** — `503`, `404`.
- **Prefix wildcard** — `"50x"`, `"49x"` (a tens band, e.g. `500`–`509`).

Pass an array to combine them: `metric: [404, "50x", "5xx"]`. With access logs enabled, every form matches exactly. On the metric-alarm path (no access logs), only the built-in API Gateway `4xx`/`5xx` count metrics exist, so exact/prefix matchers are widened to their status class (e.g. `503` → `5xx`) with a deploy-time warning — enable access logs for code-level granularity.

> The previous `"both"` value is removed; use `["4xx", "5xx"]` instead.

## AI analysis (optional)

Pass an `ai` config and every `Function` / `Cron` error gets analyzed by an LLM. The alert body includes a "Likely cause / Suggested fix" block alongside the raw error.

```ts
const alerts = new Monitor("Alerts", {
  email: "you@example.com",
  ai: {
    provider: "anthropic",
    model: "claude-haiku-4-5",
  },
});
```

### Supported providers

Set `ai.provider` to one of four values. Each talks to its vendor's own HTTP API directly — no SDK is bundled.

| `provider`    | Vendor    | Endpoint                                        | Default `model`          | Key looks like |
| ------------- | --------- | ----------------------------------------------- | ------------------------ | -------------- |
| `"anthropic"` | Anthropic | `api.anthropic.com/v1/messages`                  | `claude-haiku-4-5`       | `sk-ant-...`   |
| `"openai"`    | OpenAI    | `api.openai.com/v1/chat/completions`             | `gpt-5.6-luna`           | `sk-...`       |
| `"grok"`      | xAI       | `api.x.ai/v1/chat/completions`                   | `grok-4.5`               | `xai-...`      |
| `"gemini"`    | Google    | `generativelanguage.googleapis.com/v1beta`       | `gemini-3.5-flash-lite`  | `AIza...`      |

The defaults lean cheap-and-fast — triage does not need a frontier model. Override any of them with `ai.model`:

```ts
new Monitor("Alerts", {
  email: "you@example.com",
  ai: { provider: "gemini", model: "gemini-3.6-flash" },
});
```

One provider per `Monitor`. The provider choice only affects who gets called — every other feature (dedup, source context, all delivery channels) behaves identically.

### Setting the API key

Monitor creates a single API key secret for you, named `AiApiKey` (shared across all Monitor instances in the app) regardless of which provider you picked. To activate AI analysis you must:

```bash
# 1. Set the secret value for your chosen provider (per stage)
sst secret set AiApiKey sk-ant-...

# 2. Redeploy so the linked notifier Lambda picks it up
sst deploy
```

If you deployed before setting the secret, AI calls are silently skipped on the first deploy — the alert's `ANALYSIS` block will say _"AI analysis skipped: AiApiKey secret has no value or is not linked"_ until you set it and redeploy. Switching providers means overwriting the same secret with the new vendor's key and redeploying.

### What changes when AI is enabled

- `Function` and `Cron` switch from a metric filter + alarm to a **CloudWatch Logs subscription filter + a small notifier Lambda**. The notifier sees the actual error text, calls your provider, and fans the formatted message out to every configured channel.
- `ApiGatewayV2` and `Queue` keep the metric+alarm path — those signals don't carry a log line to feed an AI.
- One alert per Lambda invocation batch, not per error event. A 100-error spike inside a single batch produces one alert summarizing the count and analyzing the first error.
- If the provider call fails (rate limit, network blip, bad key), the alert is still sent with `(AI analysis failed: ...)` in the analysis slot. Alerts are never silently dropped.

**Security note — prompt injection mitigation.** Log messages and access-log fields (URL paths, error messages, etc.) can contain attacker-controlled text. To prevent injected instructions from being followed by the AI, all untrusted content is wrapped in `<log_data>` tags and the system prompt explicitly instructs the model to treat everything inside those tags as raw data only, never as instructions. This applies identically across all four providers.

## Notification channels

`email`, `slack` and `discord` are independent and additive — configure any combination and **every configured channel receives every alert**. Each accepts a single value or an array.

```ts
const alerts = new Monitor("Alerts", {
  email: ["you@example.com", "oncall@example.com"],
  slack: "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX",
  discord: "https://discord.com/api/webhooks/1234567890/XXXXXXXX",
  ai: { provider: "anthropic" },
});
```

### Email

Delivered via SNS email subscriptions. After your first `sst deploy`, AWS sends a confirmation email to each address — click the link once and alerts start landing.

### Slack

Create an [incoming webhook](https://api.slack.com/messaging/webhooks) for the channel you want alerts in and paste the URL into `slack`. Messages arrive as the alert subject in bold followed by the plain-text body in a code block. `&`, `<` and `>` are escaped before sending, so values like `<redacted>` render literally and text from a request (for example `<!channel>`) can never trigger a mention.

### Discord

Create a channel webhook (Channel Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL) and paste it into `discord`. Same shape as Slack. Every message is sent with `allowed_mentions: { parse: [] }`, so an `@everyone`, `@here` or user mention in the alert text never pings anyone.

Discord caps a message at 2000 characters, so the raw error block is trimmed harder there (800 chars vs 4000 for email) — this is deliberate, so the `ANALYSIS` block always survives. If you want the untruncated stack trace, follow the `LOGS` link or read the email.

### Notes

- **Webhook URLs are plain config, not secrets.** They are passed straight into the notifier Lambda's environment, the same way email addresses are passed to SNS. Anyone with read access to your AWS account or Pulumi state can read them. If that matters for your threat model, keep alerts on email and rotate the webhook if it leaks.
- Monitor validates each URL at deploy time: a non-`https` or unparseable URL throws, and an unexpected host (anything other than `hooks.slack.com` / `discord.com` and friends) logs a warning but still deploys.
- **Channels fail independently.** Delivery runs with `Promise.allSettled`, so a revoked Slack webhook cannot stop the email from sending; the failure is logged to the notifier's own CloudWatch logs.
- Configuring no channel at all logs a deploy-time warning — alerts would be generated and delivered nowhere.

## Dedup (auto-on with AI)

When `ai` is set, Monitor also creates a small DynamoDB table and uses it to suppress repeat alerts for the same error. Without this, a function stuck in an error loop would alert you — and bill your AI provider — on every single batch.

How it works:

- Each error gets a **fingerprint**: SHA-256 of the first error line plus the first stack frame, with timestamps, UUIDs, hex IDs, and large numbers normalized away. The same bug from different requests collapses to one fingerprint; genuinely different bugs stay separate.
- The notifier writes the fingerprint to DynamoDB with a conditional `UpdateItem`. Win the race → send the alert and start the cooldown. Lose the race → just bump a counter and exit (no alert, no AI call). The dedup gate runs *before* the AI call, so suppressed repeats cost nothing.
- When the cooldown expires and the same error happens again, the next email includes `Recurring: N occurrences silenced during cooldown` so you know it's still ongoing — not a fresh one-off.
- DynamoDB TTL deletes rows when their cooldown ends, so storage is self-cleaning and effectively free.

Tune or disable:

```ts
new Monitor("Alerts", {
  email: "you@example.com",
  ai: { provider: "anthropic" },
  dedupe: { cooldown: 900 },
});

new Monitor("AlertsNoDedup", {
  email: "you@example.com",
  ai: { provider: "anthropic" },
  dedupe: false,
});
```

Default cooldown is 3600 seconds (1 hour). At that setting, a single error type produces at most 24 emails per day no matter how often it fires.

## Source context (optional)

When `sourceContext: true` is set on `Monitor`, the handler's **original TypeScript source** — the entry file plus every project file it imports, followed transitively — is bundled into JSON and uploaded to a Monitor-owned S3 bucket at deploy time. The notifier fetches that bundle on each error and appends it to the AI prompt, so suggested fixes cite real file paths and function names instead of guessing from a minified frame.

```ts
const alerts = new Monitor("Alerts", {
  email: "you@example.com",
  ai: { provider: "anthropic" },
  sourceContext: true,
});
```

How it works:

- Monitor resolves the handler string (e.g. `"src/api.handler"`) to a source file, crawls its relative `import` / `require` graph, and stores the result keyed by the function's log group. Files outside the project and anything under `node_modules` are excluded.
- If the handler can't be resolved, it falls back to bundling the project's `src/` directory, and warns at deploy time if there isn't one.
- The handler file is included up to 5000 characters, each other file up to 3000.
- For API Gateway routes, a route → bundle index is written too, so an **access-log** alert (which carries no stack trace) can still pull the backing handler's source. This is what makes 500s from a `try`/`catch` that swallows the error diagnosable.

This only feeds the AI prompt — the alert body itself just lists the file names under `Source context:`. It has no effect unless `ai` is also configured.

Cost note: one tiny S3 GET per error, cached in-memory across warm invocations. Bundles are stored once per stage, not per error.

## Request context (who it happened to)

An alert that says `POST /v1/migrate` returned 500 tells you nothing about **who** it affected. Request context puts the identifying details — source IP, user agent, auth identity, request headers and the request body — into the alert body.

It is on by default and arrives through two independent paths.

### Path 1 — access log fields (no code change)

Every API Gateway alert now carries the caller details SST already logs: source IP, user agent and response latency. Nothing to configure.

To also get the **authenticated identity** — the JWT `sub`/`email`, or your Lambda authorizer's context — widen the access log format with the exported helper:

```ts
const { Monitor, accessLogFormat } = await import("whatwentwrong");

const api = new sst.aws.ApiGatewayV2("Api", {
  transform: { stage: accessLogFormat() },
});
```

That emits a superset of SST's default format, so nothing you already rely on changes. Name your own fields if you need them:

```ts
accessLogFormat({
  authorizerClaims: ["sub", "email", "org_id"],
  authorizerContext: ["userId", "tenantId"],
});
```

`authorizerClaims` maps to `$context.authorizer.claims.<name>` (JWT authorizers); `authorizerContext` maps to `$context.authorizer.<name>` (the context map a Lambda authorizer returns). Routes with no authorizer log `-` for these, and the notifier drops them rather than printing a blank identity.

### Path 2 — the handler wrapper (headers and body)

**API Gateway cannot log request headers or request bodies.** HTTP APIs expose no `$context` variable for either, and they support no REST-style execution logging. Those values exist only inside your Lambda's `event`, so capturing them takes one line per handler:

```ts
import { captureRequest } from "whatwentwrong/capture";

export const handler = captureRequest(async (event) => {
  ...
});
```

On failure the wrapper writes a single redacted line to CloudWatch, which the notifier merges into the alert. It fires in two cases:

- **The handler throws.** The error is rethrown unchanged, so your stack trace still reaches the alert exactly as before.
- **The handler returns a 4xx or 5xx without throwing.** This is the `try { ... } catch { return { statusCode: 500 } }` blind spot described above — previously undiagnosable, because CloudWatch saw nothing. It now produces a full alert.

The wrapper never changes what your handler returns and never swallows an error. If anything inside the capture itself fails, it is discarded silently and your handler's result or exception is preserved untouched. Non-HTTP invocations (SQS, cron) pass straight through.

Per-handler options:

```ts
captureRequest(handler, {
  headers: true,
  body: true,
  maxBodyChars: 2000,
  redact: ["x-internal-trace"],
  allow: ["refresh_token"],
  captureStatusFrom: 400,
});
```

### What gets redacted

Redaction runs **inside your own Lambda, before anything is written to CloudWatch** — so credentials never enter your logs in the first place. The notifier redacts again on the way out.

| Rule | Matches |
| --- | --- |
| Key name | `authorization`, `cookie`, `set-cookie`, `apikey`, `password`, `passwd`, `token`, `secret`, `credential`, `privatekey`, `sessionid`, `ssn`, `creditcard`, `cardnumber`, `cvv` |
| Value shape | JWTs, `Bearer`/`Basic`/`Digest` values, SSN-formatted numbers, 13–19 digit card-shaped runs |

Key matching is case-insensitive and ignores `-`, `_`, `.` and spaces, so `X-API-Key`, `apiKey` and `api_key` all match. Matching is by substring, so `refreshToken` and `user_password` are caught too. Nested JSON is walked; arrays cap at 20 items and nesting at 6 levels; base64 bodies are decoded first and binary ones reported as `<binary, N bytes>`.

Add your own terms, or turn parts off, on the `Monitor`:

```ts
new Monitor("Alerts", {
  email: "you@example.com",
  requestContext: {
    body: false,
    maxBodyChars: 500,
    redact: ["x-tenant-secret"],
    includeInAi: false,
  },
});

new Monitor("AlertsNoContext", {
  email: "you@example.com",
  requestContext: false,
});
```

`includeInAi: false` keeps the captured data out of the AI prompt. It defaults to `true` — and enabling it also **tightens** existing behaviour: before this feature the notifier sent the entire unredacted access-log entry to your AI provider, which is now redacted on the same rules as everything else.

> **This is customer data.** With `body: true` (the default), request bodies land in your inbox, in any Slack or Discord channel you have configured, and — unless you set `includeInAi: false` — in your AI provider's prompt logs. Redaction covers credentials, not PII: emails, user IDs and tenant names come through, because that is the point of the feature. Set `body: false` if that is not what you want, and see [Seeing a redacted value](#seeing-a-redacted-value) before reaching for `redact: false`.

### Seeing a redacted value

Sometimes the redacted field *is* the one that identifies the user — a refresh token on `POST /auth/refresh`, say. Two ways out, from surgical to blunt.

**`allow`** un-redacts named fields and leaves everything else masked. The name is matched whole (after lowercasing and stripping `-`, `_`, `.`), so `allow: ["refresh_token"]` matches `refresh_token` and `refreshToken` but not `api_token`. An allowed field also bypasses the value-shape rules, so a JWT under an allowed name comes through intact.

**`redact: false`** turns redaction off completely — every header, cookie and body field arrives verbatim. Size and depth caps still apply. Monitor logs a deploy-time warning when you do this.

> **Both settings must be applied in two places.** Redaction runs first inside your handler and again in the notifier, and the two are configured separately — the notifier cannot un-redact what the wrapper already masked.

```ts
export const handler = captureRequest(refresh, { allow: ["refresh_token"] });
```

```ts
new Monitor("Alerts", {
  email: "you@example.com",
  requestContext: { allow: ["refresh_token"] },
});
```

For a quick one-off investigation you can skip the handler half by setting `WWW_REDACT=off` in the function's environment; an explicit `redact` option always wins over it.

Request **bodies** are only re-checked in the notifier for size (clipped to the Monitor's `maxBodyChars`), so an `allow` on a body field works with the wrapper setting alone. **Headers** and **identity** are re-checked, so those need both. When in doubt, set both.


### Duplicate alerts

When request context is enabled, API Gateway route functions get their own log subscription so the wrapper's line can reach the notifier. A failing wrapped route would then alert twice — once from the function log, once from the access log — so the notifier records a short-lived per-request marker in the dedup table and suppresses the access-log twin.

This needs the dedup table, which exists unless you set `dedupe: false`; Monitor warns at deploy time if you disable it. The two log subscriptions are delivered independently, so in the rare case the access log arrives first you may still see both.

## What an alert looks like

With `ai` and `sourceContext` both enabled:

```
Subject: [Alert] my-app-MyFunction: TypeError: Cannot read properties of un...

Time: 2026-05-09T14:23:45.123Z
Log group: /aws/lambda/my-app-MyFunction
Request ID: 8f2c1d90-5b7a-4e11-9c3f-2a6b8d4e0f17
Errors in batch: 7 (showing first)
Recurring: 124 occurrences silenced during cooldown.
Fingerprint: 7c4a9b1e0f3d2a85
Source context: src/api.ts, src/lib/db.ts

REQUEST
───────
Method: POST /v1/migrate
Source IP: 41.13.8.22
User agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
Identity: sub=u_8821, email=jo@acme.io
Headers:
  content-type: application/json
  x-tenant-id: acme
  authorization: <redacted>
Body:
  {"userId":"u_8821","email":"jo@acme.io","password":"<redacted>"}

ERROR
─────
TypeError: Cannot read properties of undefined (reading 'foo')
    at Object.<anonymous> (/var/task/index.mjs:1:42345)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)

ANALYSIS
────────
Likely cause: src/api.ts dereferences body.foo in handler() without checking that event.body is defined.
Suggested fix: Use optional chaining (body?.foo) or guard with `if (!body) return { statusCode: 400 }` before the dereference.

LOGS
────
https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/...
```

Slack and Discord receive the same body, with the subject in bold above it and the body in a code block.

Each block is independent:

- `Recurring:` only appears after a cooldown re-arm.
- `Source context:` only appears when `sourceContext: true`.
- `REQUEST` only appears when request context is available — always for API Gateway access-log alerts, and for function errors whose handler is wrapped in `captureRequest`.
- `ANALYSIS` only appears when `ai` is configured.

On Slack and Discord the `REQUEST` block is budgeted separately from the error text. Discord's 2000-character cap is tight, so when space runs out the body is dropped first, then header values, then header names — the identifying lines (method, source IP, identity) and the `ANALYSIS` block always survive.

## Cost

For typical apps everything sits inside the AWS free tier:

| Resource             | Free tier                      | Past free tier                  |
| -------------------- | ------------------------------ | ------------------------------- |
| SNS email            | 1,000 / month                  | ~$2 per 100k                    |
| CloudWatch alarms    | 10 / account                   | ~$0.10 / alarm / month          |
| CloudWatch metric filters | unlimited                 | free                            |
| CloudWatch Logs subscription filters | unlimited           | free (data scanned ~$0.005/GB)  |
| Lambda (notifier)    | 1M invocations + 400k GB-s     | rounding error at error rates   |
| DynamoDB on-demand   | 25 GB + 25 RCU/WCU equivalents | ~$1.25 / M writes               |
| Slack / Discord webhooks | free                       | free                            |
| AI provider (default models) | n/a                    | fractions of a cent per analyzed batch |

If your app stays inside the free tier on its own, this package will too.

## API reference

```ts
new Monitor(name: string, args?: MonitorArgs);

interface MonitorArgs {
  email?: string | string[];
  slack?: string | string[];
  discord?: string | string[];
  ai?: {
    provider: "anthropic" | "openai" | "grok" | "gemini";
    model?: pulumi.Input<string>;
  };
  dedupe?: { cooldown?: number } | false;
  sourceContext?: boolean;
  requestContext?: RequestContextConfig | false;
}

interface RequestContextConfig {
  headers?: boolean;
  body?: boolean;
  maxBodyChars?: number;
  redact?: string[] | false;
  allow?: string[];
  includeInAi?: boolean;
}

monitor.watch(resource | resource[], opts?: WatchOptions): void;

interface WatchOptions {
  pattern?: string;
  threshold?: number;
  period?: number;
  metric?: MetricMatcher | MetricMatcher[];
}

type MetricMatcher = number | `${number}xx` | `${number}${number}x`;
```

Also exported from the package root:

```ts
function accessLogFormat(fields?: AccessLogFields): (args: AccessLogStageArgs) => void;

interface AccessLogFields {
  authorizerClaims?: readonly string[];
  authorizerContext?: readonly string[];
}
```

And from the `whatwentwrong/capture` subpath, for use inside your handlers:

```ts
function captureRequest<E, R>(
  handler: (event: E, context?: unknown) => R | Promise<R>,
  options?: CaptureOptions,
): (event: E, context?: unknown) => Promise<R>;

interface CaptureOptions {
  headers?: boolean;
  body?: boolean;
  maxBodyChars?: number;
  redact?: readonly string[] | false;
  allow?: readonly string[];
  captureStatusFrom?: number;
}
```

`whatwentwrong/capture` imports nothing from Pulumi or SST, so it is safe to import from a Lambda handler.

The `Monitor` instance also exposes:

| Property        | Type                    | Present when            |
| --------------- | ----------------------- | ----------------------- |
| `.topic`        | `aws.sns.Topic`         | always (the email fan-out topic) |
| `.alarmTopic`   | `aws.sns.Topic`         | always (CloudWatch alarms → notifier) |
| `.notifier`     | `sst.aws.Function`      | always |
| `.dedupTable`   | `aws.dynamodb.Table`    | dedup is on |
| `.apiKeySecret` | `sst.Secret`            | `ai` is configured |
| `.sourceBucket` | `aws.s3.BucketV2`       | `sourceContext: true` |

Use them if you want to attach extra subscriptions or grants yourself.

## Roadmap

- ✅ v0.2 (shipped): Source context — the handler's original source and its import graph fed into the AI prompt.
- ✅ v0.3 (shipped): OpenAI, Grok and Gemini providers alongside Anthropic; Slack and Discord delivery via the same notifier Lambda.
- ✅ v0.4 (shipped): Request context — source IP, user agent, auth identity, headers and request body in the alert, redacted by default.
- v0.5: Per-channel routing (send alarms to one channel, function errors to another).

## License

MIT
