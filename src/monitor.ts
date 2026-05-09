import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
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
  apiKey: pulumi.Input<string>;
  model?: pulumi.Input<string>;
}

export interface WatchOptions {
  pattern?: string;
  threshold?: number;
  period?: number;
}

export type Watchable = pulumi.ComponentResource;

const DEFAULT_PATTERN = '?ERROR ?Exception ?"Task timed out" ?"Unhandled"';
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = join(HERE, "runtime");

export class Monitor {
  public readonly topic: aws.sns.Topic;
  public readonly notifier?: aws.lambda.Function;
  public readonly dedupTable?: aws.dynamodb.Table;

  private readonly name: string;
  private readonly ai?: AiConfig;
  private counter = 0;

  constructor(name: string, args: MonitorArgs = {}) {
    this.name = name;
    this.ai = args.ai;
    this.topic = new aws.sns.Topic(`${name}Topic`);

    const emails =
      args.email == null
        ? []
        : Array.isArray(args.email)
          ? args.email
          : [args.email];

    emails.forEach((endpoint, i) => {
      new aws.sns.TopicSubscription(`${name}Email${i}`, {
        topic: this.topic.arn,
        protocol: "email",
        endpoint,
      });
    });

    if (this.ai) {
      const dedupCooldown = resolveDedupCooldown(args.dedupe);
      if (dedupCooldown != null) {
        this.dedupTable = this.buildDedupTable();
      }
      this.notifier = this.buildNotifier(this.ai, dedupCooldown);
    }
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
        throw new Error(
          `Monitor.watch: unsupported resource kind "${kind}". Supported: Function, ApiGatewayV2, Queue, Cron.`,
        );
    }
  }

  private watchFunction(id: string, fn: AnyResource, opts: WatchOptions): void {
    const logGroup = fn?.nodes?.logGroup;
    if (!logGroup) {
      throw new Error(
        `Monitor.watch (${id}): no nodes.logGroup found — is this an sst.aws.Function?`,
      );
    }

    if (this.notifier) {
      this.subscribeNotifier(id, logGroup, opts);
      return;
    }

    new aws.cloudwatch.LogMetricFilter(`${id}Filter`, {
      logGroupName: logGroup.name,
      pattern: opts.pattern ?? DEFAULT_PATTERN,
      metricTransformation: {
        name: id,
        namespace: `${this.name}/Errors`,
        value: "1",
        defaultValue: "0",
      },
    });

    new aws.cloudwatch.MetricAlarm(`${id}Alarm`, {
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      evaluationPeriods: 1,
      period: opts.period ?? 60,
      threshold: opts.threshold ?? 1,
      statistic: "Sum",
      metricName: id,
      namespace: `${this.name}/Errors`,
      treatMissingData: "notBreaching",
      alarmActions: [this.topic.arn],
    });
  }

  private watchApi(id: string, api: AnyResource, opts: WatchOptions): void {
    const apiId = api?.nodes?.api?.id;
    if (!apiId) {
      throw new Error(
        `Monitor.watch (${id}): no nodes.api.id found — is this an sst.aws.ApiGatewayV2?`,
      );
    }

    new aws.cloudwatch.MetricAlarm(`${id}5xxAlarm`, {
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      evaluationPeriods: 1,
      period: opts.period ?? 60,
      threshold: opts.threshold ?? 1,
      statistic: "Sum",
      metricName: "5xx",
      namespace: "AWS/ApiGateway",
      dimensions: { ApiId: apiId },
      treatMissingData: "notBreaching",
      alarmActions: [this.topic.arn],
    });
  }

  private watchQueue(id: string, queue: AnyResource, opts: WatchOptions): void {
    const queueName = queue?.nodes?.queue?.name;
    if (!queueName) {
      throw new Error(
        `Monitor.watch (${id}): no nodes.queue.name found — is this an sst.aws.Queue?`,
      );
    }

    new aws.cloudwatch.MetricAlarm(`${id}AgeAlarm`, {
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 1,
      period: opts.period ?? 60,
      threshold: opts.threshold ?? 300,
      statistic: "Maximum",
      metricName: "ApproximateAgeOfOldestMessage",
      namespace: "AWS/SQS",
      dimensions: { QueueName: queueName },
      treatMissingData: "notBreaching",
      alarmActions: [this.topic.arn],
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
    const notifier = this.notifier!;

    const permission = new aws.lambda.Permission(`${id}InvokeNotifier`, {
      action: "lambda:InvokeFunction",
      function: notifier.name,
      principal: "logs.amazonaws.com",
      sourceArn: pulumi.interpolate`${logGroup.arn}:*`,
    });

    new aws.cloudwatch.LogSubscriptionFilter(
      `${id}Sub`,
      {
        logGroup: logGroup.name,
        filterPattern: opts.pattern ?? DEFAULT_PATTERN,
        destinationArn: notifier.arn,
      },
      { dependsOn: [permission] },
    );
  }

  private buildDedupTable(): aws.dynamodb.Table {
    return new aws.dynamodb.Table(`${this.name}Dedup`, {
      billingMode: "PAY_PER_REQUEST",
      hashKey: "fingerprint",
      attributes: [{ name: "fingerprint", type: "S" }],
      ttl: { attributeName: "cooldownEnds", enabled: true },
    });
  }

  private buildNotifier(
    ai: AiConfig,
    dedupCooldown: number | null,
  ): aws.lambda.Function {
    const name = this.name;

    const role = new aws.iam.Role(`${name}NotifierRole`, {
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

    new aws.iam.RolePolicyAttachment(`${name}NotifierBasic`, {
      role: role.name,
      policyArn:
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    });

    new aws.iam.RolePolicy(`${name}NotifierPublish`, {
      role: role.id,
      policy: pulumi.jsonStringify({
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
      new aws.iam.RolePolicy(`${name}NotifierDedup`, {
        role: role.id,
        policy: pulumi.jsonStringify({
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

    const env: Record<string, pulumi.Input<string>> = {
      SNS_TOPIC_ARN: this.topic.arn,
      ANTHROPIC_API_KEY: ai.apiKey,
      ANTHROPIC_MODEL: ai.model ?? "claude-haiku-4-5",
    };
    if (this.dedupTable && dedupCooldown != null) {
      env.DEDUP_TABLE = this.dedupTable.name;
      env.DEDUP_COOLDOWN = String(dedupCooldown);
    }

    return new aws.lambda.Function(`${name}Notifier`, {
      runtime: "nodejs22.x",
      handler: "notifier.handler",
      role: role.arn,
      timeout: 30,
      memorySize: 256,
      code: new pulumi.asset.AssetArchive({
        "notifier.mjs": new pulumi.asset.FileAsset(
          join(RUNTIME_DIR, "notifier.mjs"),
        ),
        "package.json": new pulumi.asset.StringAsset(
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
  const t =
    (resource as { __pulumiType?: string } | undefined)?.__pulumiType ?? "";
  return t.split(":").pop() ?? "";
}
