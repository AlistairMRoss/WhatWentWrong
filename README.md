# whatwentwrong

Drop-in error alerting for [SST v3 (ion)](https://sst.dev) projects. Add it to your stack, point it at the resources you care about, and get an email the moment something throws — optionally with a Claude-generated cause-and-fix included in the body.

```ts
const alerts = new Monitor("Alerts", { email: "you@example.com" });
alerts.watch([api, queue, cron]);
```

That's the whole minimum setup. No CloudWatch dashboards to wire, no SNS topic to remember, no IAM policies to write.

## Install

```bash
bun install whatwentwrong
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

| Resource              | Signal                                       | Default trigger          |
| --------------------- | -------------------------------------------- | ------------------------ |
| `sst.aws.Function`    | CloudWatch Logs match on `ERROR`, `Exception`, `Task timed out`, `Unhandled` | 1+ in any 60s window     |
| `sst.aws.Cron`        | Same as Function (watches the underlying handler)                            | 1+ in any 60s window     |
| `sst.aws.ApiGatewayV2`| API Gateway `5xx` metric                                                     | 1+ in any 60s window     |
| `sst.aws.Queue` (SQS) | `ApproximateAgeOfOldestMessage`                                              | greater than 300 seconds |

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

| Option       | Applies to       | Description                                                            |
| ------------ | ---------------- | ---------------------------------------------------------------------- |
| `pattern`    | Function, Cron   | CloudWatch Logs filter pattern. Plain text, JSON, or quoted phrases.   |
| `threshold`  | all              | Threshold for the alarm. Default 1 for error counts, 300 for queue age.|
| `period`     | all              | Evaluation window in seconds. Default 60.                              |

## AI analysis (optional)

Pass an `ai` config and every `Function` / `Cron` error gets analyzed by Claude. The email body includes a "Likely cause / Suggested fix" block alongside the raw error.

```ts
const anthropicKey = new sst.Secret("AnthropicApiKey");

const alerts = new Monitor("Alerts", {
  email: "you@example.com",
  ai: {
    provider: "anthropic",
    apiKey: anthropicKey.value,
    model: "claude-haiku-4-5",
  },
});
```

Set the secret once per stage:

```bash
sst secret set AnthropicApiKey sk-ant-...
```

What changes when AI is enabled:

- `Function` and `Cron` switch from a metric filter + alarm to a **CloudWatch Logs subscription filter + a small notifier Lambda**. The notifier sees the actual error text, calls Anthropic, and publishes the formatted message to SNS.
- `ApiGatewayV2` and `Queue` keep the metric+alarm path — those signals don't carry a log line to feed an AI.
- One email per Lambda invocation batch, not per error event. A 100-error spike inside a single batch produces one email summarizing the count and analyzing the first error.
- If the Anthropic call fails (rate limit, network blip, bad key), the email is still sent with `(AI analysis failed: ...)` in the analysis slot. Alerts are never silently dropped.

Default model is `claude-haiku-4-5` (cheapest, fast enough for triage). Override via `ai.model`.

## Dedup (auto-on with AI)

When `ai` is set, Monitor also creates a small DynamoDB table and uses it to suppress repeat emails for the same error. Without this, a function stuck in an error loop would email you — and bill Anthropic — on every single batch.

How it works:

- Each error gets a **fingerprint**: SHA-256 of the first error line plus the first stack frame, with timestamps, UUIDs, hex IDs, and large numbers normalized away. The same bug from different requests collapses to one fingerprint; genuinely different bugs stay separate.
- The notifier writes the fingerprint to DynamoDB with a conditional `UpdateItem`. Win the race → send the email and start the cooldown. Lose the race → just bump a counter and exit (no email, no Anthropic call).
- When the cooldown expires and the same error happens again, the next email includes `Recurring: N occurrences silenced during cooldown` so you know it's still ongoing — not a fresh one-off.
- DynamoDB TTL deletes rows when their cooldown ends, so storage is self-cleaning and effectively free.

Tune or disable:

```ts
new Monitor("Alerts", {
  email: "you@example.com",
  ai: { provider: "anthropic", apiKey: anthropicKey.value },
  dedupe: { cooldown: 900 },
});

new Monitor("AlertsNoDedup", {
  email: "you@example.com",
  ai: { provider: "anthropic", apiKey: anthropicKey.value },
  dedupe: false,
});
```

Default cooldown is 3600 seconds (1 hour). At that setting, a single error type produces at most 24 emails per day no matter how often it fires.

## What an alert looks like

```
Subject: [Alert] my-app-MyFunction: TypeError: Cannot read properties of un...

Time: 2026-05-09T14:23:45.123Z
Log group: /aws/lambda/my-app-MyFunction
Errors in batch: 7 (showing first)
Recurring: 124 occurrences silenced during cooldown.
Fingerprint: 7c4a9b1e0f3d2a85

ERROR
─────
TypeError: Cannot read properties of undefined (reading 'foo')
    at Object.<anonymous> (/var/task/index.js:42:13)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)

ANALYSIS
────────
Likely cause: The handler dereferences event.body.foo without first checking that event.body is defined.
Suggested fix: Use optional chaining (event.body?.foo) or guard with `if (!event.body) return ...` at the top of the handler.

LOGS
────
https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/...
```

The `Recurring:` line only appears after a cooldown re-arm. The `ANALYSIS` block only appears when `ai` is configured.

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
| Claude Haiku 4.5     | n/a                            | ~$0.001 per analyzed batch      |

If your app stays inside the free tier on its own, this package will too.

## API reference

```ts
new Monitor(name: string, args?: MonitorArgs);

interface MonitorArgs {
  email?: string | string[];
  ai?: {
    provider: "anthropic";
    apiKey: pulumi.Input<string>;
    model?: pulumi.Input<string>;
  };
  dedupe?: { cooldown?: number } | false;
}

monitor.watch(resource | resource[], opts?: WatchOptions): void;

interface WatchOptions {
  pattern?: string;
  threshold?: number;
  period?: number;
}
```

The `Monitor` instance also exposes `.topic` (the `aws.sns.Topic`), `.notifier` (the `aws.lambda.Function`, when AI is on), and `.dedupTable` (the `aws.dynamodb.Table`, when dedup is on) if you want to attach extra subscriptions or grants yourself.

## Roadmap

- v0.2: Discord webhook delivery via the same notifier Lambda.
- v0.3: Optional rollup digest email when a long-running issue finally resolves.
- v0.4: OpenAI provider.

## License

MIT
