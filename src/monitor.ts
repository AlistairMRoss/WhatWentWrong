import * as $aws from "@pulumi/aws";
import * as $pulumi from "@pulumi/pulumi";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MonitorArgs {
  email?: string | string[];
  ai?: AiConfig;
  dedupe?: DedupeConfig | false;
}

export interface DedupeConfig {
  cooldown?: number;
}

export type AiConfig = AnthropicConfig;

export interface AnthropicConfig {
  provider: "anthropic";
  apiKey: $pulumi.Input<string>;
  model?: $pulumi.Input<string>;
}

export interface WatchOptions {
  pattern?: string;
  threshold?: number;
  period?: number;
  metric?: "4xx" | "5xx" | "both";
}

export type Watchable = $pulumi.ComponentResource;

const DEFAULT_PATTERN = '?ERROR ?Exception ?"Task timed out" ?"Unhandled"';
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = join(HERE, "runtime");

export class Monitor {
  public readonly topic: $aws.sns.Topic;
  public readonly alarmTopic: $aws.sns.Topic;
  public readonly notifier: $aws.lambda.Function;
  public readonly dedupTable?: $aws.dynamodb.Table;

  private readonly name: string;
  private readonly ai?: AiConfig;
  private counter = 0;

  constructor(name: string, args: MonitorArgs = {}) {
    this.name = name;
    this.ai = args.ai;
    this.topic = new $aws.sns.Topic(`${name}Topic`);
    this.alarmTopic = new $aws.sns.Topic(`${name}AlarmTopic`);

    const emails =
      args.email == null
        ? []
        : Array.isArray(args.email)
          ? args.email
          : [args.email];

    emails.forEach((endpoint, i) => {
      new $aws.sns.TopicSubscription(`${name}Email${i}`, {
        topic: this.topic.arn,
        protocol: "email",
        endpoint,
      });
    });

    const dedupCooldown = resolveDedupCooldown(args.dedupe);
    if (dedupCooldown != null) {
      this.dedupTable = this.buildDedupTable();
    }
    this.notifier = this.buildNotifier(this.ai, dedupCooldown);

    new $aws.lambda.Permission(`${name}NotifierAlarmPerm`, {
      action: "lambda:InvokeFunction",
      function: this.notifier.name,
      principal: "sns.amazonaws.com",
      sourceArn: this.alarmTopic.arn,
    });

    new $aws.sns.TopicSubscription(`${name}NotifierAlarmSub`, {
      topic: this.alarmTopic.arn,
      protocol: "lambda",
      endpoint: this.notifier.arn,
    });
  }

  watch(resource: Watchable | Watchable[], opts: WatchOptions = {}): void {
    const list = Array.isArray(resource) ? resource : [resource];
    for (const r of list) this.attach(r, opts);
  }

  private attach(resource: Watchable, opts: WatchOptions): void {
    this.counter += 1;
    const id = `${this.name}Watch${this.counter}`;
    const kind = detectKind(resource);

    switch (kind) {
      case "Function":
        return this.watchFunction(id, resource as AnyResource, opts);
      case "ApiGatewayV2":
        return this.watchApi(id, resource as AnyResource, opts);
      case "Queue":
        return this.watchQueue(id, resource as AnyResource, opts);
      case "Cron":
        return this.watchCron(id, resource as AnyResource, opts);
      default:
        throw new Error(describeUnknown(resource, kind));
    }
  }

  private watchFunction(id: string, fn: AnyResource, opts: WatchOptions): void {
    const logGroup = fn?.nodes?.logGroup;
    if (!logGroup) {
      throw new Error(
        `Monitor.watch (${id}): no nodes.logGroup found — is this an sst.aws.Function?`,
      );
    }

    this.subscribeNotifier(id, logGroup, opts);
  }

  private watchApi(id: string, api: AnyResource, opts: WatchOptions): void {
    const apiId = api?.nodes?.api?.id;
    if (!apiId) {
      throw new Error(
        `Monitor.watch (${id}): no nodes.api.id found — is this an sst.aws.ApiGatewayV2?`,
      );
    }

    const accessLogGroup = api?.nodes?.logGroup;
    if (accessLogGroup) {
      const choice = opts.metric ?? "5xx";
      const filterPattern =
        choice === "4xx"
          ? '{ ($.status >= 400 && $.status < 500) || $.status = "4*" }'
          : choice === "both"
            ? '{ $.status >= 400 || $.status = "4*" || $.status = "5*" }'
            : '{ $.status >= 500 || $.status = "5*" }';

      const permission = new $aws.lambda.Permission(
        `${id}AccessLogPerm`,
        {
          action: "lambda:InvokeFunction",
          function: this.notifier.name,
          principal: "logs.amazonaws.com",
          sourceArn: $pulumi.interpolate`${accessLogGroup.arn}:*`,
        },
      );

      new $aws.cloudwatch.LogSubscriptionFilter(
        `${id}AccessLogSub`,
        {
          logGroup: accessLogGroup.name,
          filterPattern,
          destinationArn: this.notifier.arn,
        },
        { dependsOn: [permission] },
      );
      return;
    }

    const choice = opts.metric ?? "5xx";
    const metrics = choice === "both" ? ["4xx", "5xx"] : [choice];

    for (const metric of metrics) {
      new $aws.cloudwatch.MetricAlarm(`${id}${metric}Alarm`, {
        comparisonOperator: "GreaterThanOrEqualToThreshold",
        evaluationPeriods: 1,
        period: opts.period ?? 60,
        threshold: opts.threshold ?? 1,
        statistic: "Sum",
        metricName: metric,
        namespace: "AWS/ApiGateway",
        dimensions: { ApiId: apiId },
        treatMissingData: "notBreaching",
        alarmActions: [this.alarmTopic.arn],
      });
    }
  }

  private watchQueue(id: string, queue: AnyResource, opts: WatchOptions): void {
    const queueName = queue?.nodes?.queue?.name;
    if (!queueName) {
      throw new Error(
        `Monitor.watch (${id}): no nodes.queue.name found — is this an sst.aws.Queue?`,
      );
    }

    new $aws.cloudwatch.MetricAlarm(`${id}AgeAlarm`, {
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 1,
      period: opts.period ?? 60,
      threshold: opts.threshold ?? 300,
      statistic: "Maximum",
      metricName: "ApproximateAgeOfOldestMessage",
      namespace: "AWS/SQS",
      dimensions: { QueueName: queueName },
      treatMissingData: "notBreaching",
      alarmActions: [this.alarmTopic.arn],
    });
  }

  private watchCron(id: string, cron: AnyResource, opts: WatchOptions): void {
    const fn = cron?.nodes?.job ?? cron?.nodes?.function;
    if (!fn) {
      throw new Error(
        `Monitor.watch (${id}): no nodes.job found — is this an sst.aws.Cron?`,
      );
    }
    this.watchFunction(id, fn, opts);
  }

  private subscribeNotifier(
    id: string,
    logGroup: AnyResource,
    opts: WatchOptions,
  ): void {
    const permission = new $aws.lambda.Permission(`${id}InvokeNotifier`, {
      action: "lambda:InvokeFunction",
      function: this.notifier.name,
      principal: "logs.amazonaws.com",
      sourceArn: $pulumi.interpolate`${logGroup.arn}:*`,
    });

    new $aws.cloudwatch.LogSubscriptionFilter(
      `${id}Sub`,
      {
        logGroup: logGroup.name,
        filterPattern: opts.pattern ?? DEFAULT_PATTERN,
        destinationArn: this.notifier.arn,
      },
      { dependsOn: [permission] },
    );
  }

  private buildDedupTable(): $aws.dynamodb.Table {
    return new $aws.dynamodb.Table(`${this.name}Dedup`, {
      billingMode: "PAY_PER_REQUEST",
      hashKey: "fingerprint",
      attributes: [{ name: "fingerprint", type: "S" }],
      ttl: { attributeName: "cooldownEnds", enabled: true },
    });
  }

  private buildNotifier(
    ai: AiConfig | undefined,
    dedupCooldown: number | null,
  ): $aws.lambda.Function {
    const name = this.name;

    const role = new $aws.iam.Role(`${name}NotifierRole`, {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    new $aws.iam.RolePolicyAttachment(`${name}NotifierBasic`, {
      role: role.name,
      policyArn:
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    });

    new $aws.iam.RolePolicy(`${name}NotifierPublish`, {
      role: role.id,
      policy: $pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "sns:Publish",
            Resource: this.topic.arn,
          },
        ],
      }),
    });

    if (this.dedupTable) {
      new $aws.iam.RolePolicy(`${name}NotifierDedup`, {
        role: role.id,
        policy: $pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["dynamodb:UpdateItem", "dynamodb:GetItem"],
              Resource: this.dedupTable.arn,
            },
          ],
        }),
      });
    }

    const env: Record<string, $pulumi.Input<string>> = {
      SNS_TOPIC_ARN: this.topic.arn,
    };
    if (ai) {
      env.ANTHROPIC_API_KEY = ai.apiKey;
      env.ANTHROPIC_MODEL = ai.model ?? "claude-haiku-4-5";
    }
    if (this.dedupTable && dedupCooldown != null) {
      env.DEDUP_TABLE = this.dedupTable.name;
      env.DEDUP_COOLDOWN = String(dedupCooldown);
    }

    return new $aws.lambda.Function(`${name}Notifier`, {
      runtime: "nodejs22.x",
      handler: "notifier.handler",
      role: role.arn,
      timeout: 30,
      memorySize: 256,
      code: new $pulumi.asset.AssetArchive({
        "notifier.mjs": new $pulumi.asset.FileAsset(
          join(RUNTIME_DIR, "notifier.mjs"),
        ),
        "package.json": new $pulumi.asset.StringAsset(
          JSON.stringify({ type: "module" }),
        ),
      }),
      environment: { variables: env },
    });
  }
}

function resolveDedupCooldown(
  dedupe: MonitorArgs["dedupe"],
): number | null {
  if (dedupe === false) return null;
  if (dedupe == null) return 3600;
  return dedupe.cooldown ?? 3600;
}

type AnyResource = { nodes?: Record<string, any> } & Record<string, any>;

function detectKind(resource: unknown): string {
  if (!resource || typeof resource !== "object") return "";
  const obj = resource as Record<string, any>;

  const t = obj.__pulumiType;
  if (typeof t === "string" && t.length > 0) {
    return t.split(":").pop() ?? "";
  }

  const ctorName = obj.constructor?.name;
  if (typeof ctorName === "string" && ctorName !== "Object") {
    return ctorName;
  }

  return "";
}

function describeUnknown(resource: unknown, kind: string): string {
  if (!resource || typeof resource !== "object") {
    return `Monitor.watch: expected an SST resource, got ${typeof resource}. Supported: Function, ApiGatewayV2, Queue, Cron.`;
  }
  const obj = resource as Record<string, any>;
  const ctor = obj.constructor?.name ?? "<unknown>";
  const pt = obj.__pulumiType;
  const keys = Object.keys(obj).slice(0, 12).join(", ");
  return (
    `Monitor.watch: could not identify resource ` +
    `(kind="${kind}", constructor="${ctor}", __pulumiType=${JSON.stringify(pt)}, keys=[${keys}]). ` +
    `Supported: Function, ApiGatewayV2, Queue, Cron.`
  );
}
