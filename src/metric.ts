export type StatusClass = `${number}xx`;
export type StatusPrefix = `${number}${number}x`;
export type MetricMatcher = number | StatusClass | StatusPrefix;

export type AlarmClass = "4xx" | "5xx";

export interface ParsedMatcher {
  low: number;
  high: number;
  wildcard: string;
  klass: AlarmClass | null;
  label: string;
}

export interface AlarmResolution {
  classes: AlarmClass[];
  widened: string[];
  dropped: string[];
}

const CLASS_RE = /^([1-5])xx$/;
const PREFIX_RE = /^([1-5])(\d)x$/;

function classOf(firstDigit: number): AlarmClass | null {
  if (firstDigit === 4) return "4xx";
  if (firstDigit === 5) return "5xx";
  return null;
}

function invalid(label: string): never {
  throw new Error(
    `Monitor.watch: invalid metric '${label}' — expected a status code (e.g. 503), a class ('5xx'), or a prefix ('50x').`,
  );
}

function parseOne(matcher: MetricMatcher): ParsedMatcher {
  const label = String(matcher);

  if (typeof matcher === "number") {
    if (!Number.isInteger(matcher) || matcher < 100 || matcher > 599) {
      invalid(label);
    }
    return {
      low: matcher,
      high: matcher,
      wildcard: label,
      klass: classOf(Math.floor(matcher / 100)),
      label,
    };
  }

  const classMatch = CLASS_RE.exec(matcher);
  if (classMatch) {
    const digit = Number(classMatch[1]);
    const low = digit * 100;
    return {
      low,
      high: low + 99,
      wildcard: `${digit}*`,
      klass: classOf(digit),
      label,
    };
  }

  const prefixMatch = PREFIX_RE.exec(matcher);
  if (prefixMatch) {
    const tens = Number(`${prefixMatch[1]}${prefixMatch[2]}`);
    const low = tens * 10;
    return {
      low,
      high: low + 9,
      wildcard: `${tens}*`,
      klass: classOf(Number(prefixMatch[1])),
      label,
    };
  }

  return invalid(label);
}

export function parseMetric(
  metric: MetricMatcher | MetricMatcher[] | undefined,
): ParsedMatcher[] {
  const list =
    metric == null ? ["5xx" as const] : Array.isArray(metric) ? metric : [metric];
  return list.map(parseOne);
}

export function buildAccessLogFilterPattern(parsed: ParsedMatcher[]): string {
  const conditions = parsed.map(
    (m) =>
      `($.status >= ${m.low} && $.status <= ${m.high}) || $.status = "${m.wildcard}"`,
  );
  return `{ ${conditions.join(" || ")} }`;
}

export function resolveAlarmClasses(parsed: ParsedMatcher[]): AlarmResolution {
  const classes: AlarmClass[] = [];
  const widened: string[] = [];
  const dropped: string[] = [];

  for (const m of parsed) {
    if (m.klass == null) {
      dropped.push(m.label);
      continue;
    }
    if (m.label !== m.klass) {
      widened.push(m.label);
    }
    if (!classes.includes(m.klass)) {
      classes.push(m.klass);
    }
  }

  return { classes, widened, dropped };
}
