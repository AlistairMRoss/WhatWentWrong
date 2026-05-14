import type * as PulumiAws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "node:fs";
import * as path from "node:path";
import { Buffer } from "node:buffer";

declare const aws: typeof PulumiAws;
declare const sst: any;
declare const $interpolate: (
  strings: TemplateStringsArray,
  ...values: any[]
) => pulumi.Output<string>;

export interface MonitorArgs {
  email?: string | string[];
  ai?: AiConfig;
  dedupe?: DedupeConfig | false;
  sourceContext?: boolean;
}

export interface DedupeConfig {
  cooldown?: number;
}

export type AiConfig = AnthropicConfig;

export interface AnthropicConfig {
  provider: "anthropic";
  model?: pulumi.Input<string>;
}

export interface WatchOptions {
  pattern?: string;
  threshold?: number;
  period?: number;
  metric?: "4xx" | "5xx" | "both";
}

export type Watchable = pulumi.ComponentResource;

const DEFAULT_PATTERN = '?ERROR ?Exception ?"Task timed out" ?"Unhandled"';
const NOTIFIER_HANDLER_PATH =
  "node_modules/whatwentwrong/dist/runtime/notifier.handler";
const AI_API_KEY_SECRET_NAME = "AiApiKey";

let sharedApiKeySecret: any | undefined;

function getOrCreateApiKeySecret(): any {
  if (!sharedApiKeySecret) {
    sharedApiKeySecret = new sst.Secret(AI_API_KEY_SECRET_NAME);
  }
  return sharedApiKeySecret;
}

const routesByApi = new WeakMap<object, Array<{ route: any; handlerArg: any }>>();
let apiRoutePatched = false;

function ensureApiRouteTracker(): void {
  if (apiRoutePatched) return;
  const ApiGatewayV2 = (sst as any)?.aws?.ApiGatewayV2;
  if (!ApiGatewayV2?.prototype?.route) return;
  apiRoutePatched = true;
  const origRoute = ApiGatewayV2.prototype.route;
  ApiGatewayV2.prototype.route = function (this: object, ...args: any[]) {
    const route = origRoute.apply(this, args);
    const list = routesByApi.get(this) ?? [];
    list.push({ route, handlerArg: args[1] });
    routesByApi.set(this, list);
    return route;
  };
}

export class Monitor {
  public readonly topic: PulumiAws.sns.Topic;
  public readonly alarmTopic: PulumiAws.sns.Topic;
  public readonly notifier: any;
  public readonly dedupTable?: PulumiAws.dynamodb.Table;
  public readonly apiKeySecret?: any;
  public readonly sourceBucket?: PulumiAws.s3.BucketV2;

  private readonly name: string;
  private readonly ai?: AiConfig;
  private readonly sourceContextEnabled: boolean;
  private counter = 0;

  constructor(name: string, args: MonitorArgs = {}) {
    ensureApiRouteTracker();
    this.name = name;
    this.ai = args.ai;
    this.sourceContextEnabled = args.sourceContext === true;
    this.topic = new aws.sns.Topic(`${name}Topic`);
    this.alarmTopic = new aws.sns.Topic(`${name}AlarmTopic`);

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
      this.apiKeySecret = getOrCreateApiKeySecret();
    }

    if (this.sourceContextEnabled) {
      this.sourceBucket = new aws.s3.BucketV2(`${name}Sources`, {
        forceDestroy: true,
      });
    }

    const dedupCooldown = resolveDedupCooldown(args.dedupe);
    if (dedupCooldown != null) {
      this.dedupTable = this.buildDedupTable();
    }
    this.notifier = this.buildNotifier(this.ai, dedupCooldown);

    new aws.lambda.Permission(`${name}NotifierAlarmPerm`, {
      action: "lambda:InvokeFunction",
      function: this.notifier.name,
      principal: "sns.amazonaws.com",
      sourceArn: this.alarmTopic.arn,
    });

    new aws.sns.TopicSubscription(`${name}NotifierAlarmSub`, {
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
      case "ApiGatewayV2LambdaRoute":
        return this.watchRoute(id, resource as AnyResource, opts);
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

    if (this.sourceContextEnabled) {
      this.uploadSourceFiles(id, fn, logGroup);
    }
  }

  private uploadSourceFiles(
    id: string,
    _fn: AnyResource,
    logGroup: AnyResource,
    handlerArg?: any,
  ): void {
    if (!this.sourceBucket) return;

    const bundleContent = buildSourceBundle(id, handlerArg);

    new aws.s3.BucketObjectv2(`${id}SourceBundle`, {
      bucket: this.sourceBucket.bucket,
      key: $interpolate`${logGroup.name}.json`,
      content: bundleContent,
      contentType: "application/json",
    });
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

      const permission = new aws.lambda.Permission(
        `${id}AccessLogPerm`,
        {
          action: "lambda:InvokeFunction",
          function: this.notifier.name,
          principal: "logs.amazonaws.com",
          sourceArn: $interpolate`${accessLogGroup.arn}:*`,
        },
      );

      new aws.cloudwatch.LogSubscriptionFilter(
        `${id}AccessLogSub`,
        {
          logGroup: accessLogGroup.name,
          filterPattern,
          destinationArn: this.notifier.arn,
        },
        { dependsOn: [permission] },
      );

      // Upload source bundles for route metadata, but skip Lambda log subscriptions —
      // the access log subscription already covers API errors, avoiding duplicate alerts.
      this.autoWatchApiRoutes(id, api, opts, false);
      return;
    }

    const choice = opts.metric ?? "5xx";
    const metrics = choice === "both" ? ["4xx", "5xx"] : [choice];

    for (const metric of metrics) {
      new aws.cloudwatch.MetricAlarm(`${id}${metric}Alarm`, {
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

    this.autoWatchApiRoutes(id, api, opts);
  }

  private autoWatchApiRoutes(
    id: string,
    api: AnyResource,
    opts: WatchOptions,
    subscribeToLogs = true,
  ): void {
    const tracked = routesByApi.get(api as object);
    let routeIdx = 0;
    if (tracked) {
      for (const { route, handlerArg } of tracked) {
        routeIdx += 1;
        this.watchRoute(`${id}AutoRoute${routeIdx}`, route, opts, handlerArg, subscribeToLogs);
      }
    }

    if ((api as any).__wwwAutoWatched) return;
    (api as any).__wwwAutoWatched = true;

    const monitor = this;
    const existingRoute = (api as any).route?.bind(api);
    if (typeof existingRoute === "function") {
      (api as any).route = function (...routeArgs: any[]) {
        const route = existingRoute(...routeArgs);
        routeIdx += 1;
        monitor.watchRoute(`${id}AutoRoute${routeIdx}`, route, opts, routeArgs[1], subscribeToLogs);
        return route;
      };
    }
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

  private watchRoute(id: string, route: AnyResource, opts: WatchOptions, handlerArg?: any, subscribeToLogs = true): void {
    const fnOutput = route?.nodes?.function;
    if (!fnOutput) {
      throw new Error(
        `Monitor.watch (${id}): no nodes.function found — is this an sst.aws.ApiGatewayV2LambdaRoute (returned from api.route())?`,
      );
    }

    const fnOut = pulumi.output(fnOutput);
    const logGroupName = fnOut.apply((fn: any) => fn.nodes.logGroup.name);
    const logGroupArn = fnOut.apply((fn: any) => fn.nodes.logGroup.arn);

    if (subscribeToLogs) {
      const permission = new aws.lambda.Permission(`${id}InvokeNotifier`, {
        action: "lambda:InvokeFunction",
        function: this.notifier.name,
        principal: "logs.amazonaws.com",
        sourceArn: pulumi.interpolate`${logGroupArn}:*`,
      });

      new aws.cloudwatch.LogSubscriptionFilter(
        `${id}Sub`,
        {
          logGroup: logGroupName,
          filterPattern: opts.pattern ?? DEFAULT_PATTERN,
          destinationArn: this.notifier.arn,
        },
        { dependsOn: [permission] },
      );
    }

    if (this.sourceContextEnabled && this.sourceBucket) {
      const bundleContent = buildSourceBundle(id, handlerArg);
      const sourceBundleKey = pulumi.interpolate`${logGroupName}.json`;

      new aws.s3.BucketObjectv2(`${id}SourceBundle`, {
        bucket: this.sourceBucket.bucket,
        key: sourceBundleKey,
        content: bundleContent,
        contentType: "application/json",
      });

      const routeKey = pulumi
        .output(route?.nodes?.route)
        .apply((r: any) => r.routeKey);

      const encodedRouteKey = routeKey.apply((k: string) =>
        Buffer.from(k).toString("base64url"),
      );

      const handlerStr = extractHandlerString(handlerArg) ?? "unknown";

      const routeMeta = pulumi
        .all([routeKey, sourceBundleKey])
        .apply(([k, sbk]: [string, string]) =>
          JSON.stringify({
            routeKey: k,
            handler: handlerStr,
            sourceBundleKey: sbk,
          }),
        );

      new aws.s3.BucketObjectv2(`${id}RouteMeta`, {
        bucket: this.sourceBucket.bucket,
        key: pulumi.interpolate`routes/${encodedRouteKey}.json`,
        content: routeMeta,
        contentType: "application/json",
      });
    }
  }

  private subscribeNotifier(
    id: string,
    logGroup: AnyResource,
    opts: WatchOptions,
  ): void {
    const permission = new aws.lambda.Permission(`${id}InvokeNotifier`, {
      action: "lambda:InvokeFunction",
      function: this.notifier.name,
      principal: "logs.amazonaws.com",
      sourceArn: $interpolate`${logGroup.arn}:*`,
    });

    new aws.cloudwatch.LogSubscriptionFilter(
      `${id}Sub`,
      {
        logGroup: logGroup.name,
        filterPattern: opts.pattern ?? DEFAULT_PATTERN,
        destinationArn: this.notifier.arn,
      },
      { dependsOn: [permission] },
    );
  }

  private buildDedupTable(): PulumiAws.dynamodb.Table {
    return new aws.dynamodb.Table(`${this.name}Dedup`, {
      billingMode: "PAY_PER_REQUEST",
      hashKey: "fingerprint",
      attributes: [{ name: "fingerprint", type: "S" }],
      ttl: { attributeName: "cooldownEnds", enabled: true },
    });
  }

  private buildNotifier(
    ai: AiConfig | undefined,
    dedupCooldown: number | null,
  ): any {
    const env: Record<string, pulumi.Input<string>> = {
      SNS_TOPIC_ARN: this.topic.arn,
    };
    if (ai) {
      env.ANTHROPIC_MODEL = ai.model ?? "claude-haiku-4-5";
      env.AI_EXPECTED = "true";
    }
    if (this.dedupTable && dedupCooldown != null) {
      env.DEDUP_TABLE = this.dedupTable.name;
      env.DEDUP_COOLDOWN = String(dedupCooldown);
    }
    if (this.sourceBucket) {
      env.SOURCE_BUCKET = this.sourceBucket.bucket;
    }

    const permissions: Array<{
      actions: string[];
      resources: pulumi.Input<string>[];
    }> = [
      { actions: ["sns:Publish"], resources: [this.topic.arn] },
    ];
    if (this.dedupTable) {
      permissions.push({
        actions: ["dynamodb:UpdateItem", "dynamodb:GetItem"],
        resources: [this.dedupTable.arn],
      });
    }
    if (this.sourceBucket) {
      permissions.push({
        actions: ["s3:GetObject"],
        resources: [$interpolate`${this.sourceBucket.arn}/*`],
      });
    }

    const fnArgs: Record<string, any> = {
      handler: NOTIFIER_HANDLER_PATH,
      runtime: "nodejs22.x",
      timeout: "30 seconds",
      memory: "256 MB",
      environment: env,
      permissions,
      nodejs: {
        esbuild: {
          external: ["@aws-sdk/*"],
        },
      },
    };
    if (this.apiKeySecret) {
      fnArgs.link = [this.apiKeySecret];
    }

    return new sst.aws.Function(`${this.name}Notifier`, fnArgs);
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

function buildSourceBundle(id: string, handlerArg?: any): string {
  const cwd = process.cwd();
  const handlerStr = extractHandlerString(handlerArg);

  if (handlerStr) {
    const entryFile = findHandlerSourceFile(handlerStr);
    if (entryFile) {
      const allFiles = collectProjectFiles(entryFile);
      const files: Record<string, string> = {};
      for (const absPath of allFiles) {
        try {
          const rel = path.relative(cwd, absPath);
          files[rel] = fs.readFileSync(absPath, "utf-8");
        } catch {}
      }
      return JSON.stringify({ handlerFile: path.relative(cwd, entryFile), files });
    }
  }

  // Fall back: walk the project's src/ directory
  const srcDir = path.join(cwd, "src");
  if (!fs.existsSync(srcDir)) {
    console.warn(
      `[whatwentwrong] Monitor.watch (${id}): no src/ directory found — source context will be unavailable.`,
    );
    return JSON.stringify({ handlerFile: "", files: {} });
  }
  const files: Record<string, string> = {};
  for (const absPath of walkTsFiles(srcDir)) {
    try {
      const rel = path.relative(cwd, absPath);
      files[rel] = fs.readFileSync(absPath, "utf-8");
    } catch {}
  }
  return JSON.stringify({ handlerFile: "", files });
}

function extractHandlerString(handlerArg: any): string | undefined {
  if (typeof handlerArg === "string" && !handlerArg.startsWith("arn:")) {
    return handlerArg;
  }
  if (handlerArg && typeof handlerArg === "object" && typeof handlerArg.handler === "string") {
    return handlerArg.handler;
  }
  return undefined;
}

function findHandlerSourceFile(handler: string): string | null {
  const withoutExport = handler.replace(/\.[^./]+$/, "");
  const cwd = process.cwd();
  const base = path.resolve(cwd, withoutExport);
  for (const ext of [".ts", ".tsx", ".js", ".mjs", ".cjs"]) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function* walkTsFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      yield* walkTsFiles(full);
    } else if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      yield full;
    }
  }
}

function collectProjectFiles(entryFile: string): string[] {
  const cwd = process.cwd();
  const visited = new Set<string>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const importRe =
      /(?:import|export)\s[^'"]*?['"](\.[^'"]+)['"]/g;
    const requireRe = /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    for (const re of [importRe, requireRe]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) {
        const resolved = resolveImportPath(file, m[1], cwd);
        if (resolved) queue.push(resolved);
      }
    }
  }
  return Array.from(visited);
}

function resolveImportPath(
  fromFile: string,
  importPath: string,
  cwd: string,
): string | null {
  const dir = path.dirname(fromFile);
  const abs = path.resolve(dir, importPath);
  if (abs.includes(`${path.sep}node_modules${path.sep}`)) return null;
  if (!abs.startsWith(cwd)) return null;
  if (path.extname(abs)) return fs.existsSync(abs) ? abs : null;
  for (const ext of [".ts", ".tsx", ".js", ".mjs", ".cjs"]) {
    if (fs.existsSync(abs + ext)) return abs + ext;
    const idx = path.join(abs, "index" + ext);
    if (fs.existsSync(idx)) return idx;
  }
  return null;
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
