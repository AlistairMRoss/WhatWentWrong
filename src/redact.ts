import { Buffer } from "node:buffer";

export const REDACTED = "<redacted>";

export const DEFAULT_DENY_KEYS: readonly string[] = [
  "authorization",
  "cookie",
  "setcookie",
  "apikey",
  "password",
  "passwd",
  "token",
  "secret",
  "credential",
  "privatekey",
  "sessionid",
  "ssn",
  "creditcard",
  "cardnumber",
  "cvv",
];

export const DEFAULT_MAX_BODY_CHARS = 2000;

export interface RedactionPolicy {
  enabled: boolean;
  denyKeys: readonly string[];
  allowKeys: readonly string[];
  maxBodyChars: number;
  maxDepth: number;
  maxArrayItems: number;
}

export interface RedactionOptions {
  redact?: readonly string[] | false;
  allow?: readonly string[];
  maxBodyChars?: number;
}

export const DEFAULT_REDACTION: RedactionPolicy = {
  enabled: true,
  denyKeys: DEFAULT_DENY_KEYS,
  allowKeys: [],
  maxBodyChars: DEFAULT_MAX_BODY_CHARS,
  maxDepth: 6,
  maxArrayItems: 20,
};

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s.]/g, "");
}

function normalizeTerms(terms: readonly string[] | undefined): string[] {
  return (terms ?? []).map(normalizeKey).filter((term) => term.length > 0);
}

export function policyFrom(options: RedactionOptions = {}): RedactionPolicy {
  const enabled = options.redact !== false;
  const extra = enabled ? normalizeTerms(options.redact || []) : [];
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  return {
    enabled,
    denyKeys:
      extra.length > 0 ? [...DEFAULT_DENY_KEYS, ...extra] : DEFAULT_DENY_KEYS,
    allowKeys: normalizeTerms(options.allow),
    maxBodyChars:
      Number.isFinite(maxBodyChars) && maxBodyChars > 0
        ? maxBodyChars
        : DEFAULT_MAX_BODY_CHARS,
    maxDepth: DEFAULT_REDACTION.maxDepth,
    maxArrayItems: DEFAULT_REDACTION.maxArrayItems,
  };
}

export function isAllowedKey(key: string, policy: RedactionPolicy): boolean {
  if (policy.allowKeys.length === 0) return false;
  const normalized = normalizeKey(key);
  return normalized.length > 0 && policy.allowKeys.includes(normalized);
}

export function isDeniedKey(key: string, policy: RedactionPolicy): boolean {
  if (!policy.enabled) return false;
  const normalized = normalizeKey(key);
  if (normalized.length === 0) return false;
  if (policy.allowKeys.includes(normalized)) return false;
  return policy.denyKeys.some((term) => normalized.includes(term));
}

function masksShape(value: string, policy: RedactionPolicy): boolean {
  return policy.enabled && hasSensitiveShape(value);
}

const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/;
const SCHEME_RE = /^\s*(bearer|basic|digest)\s+\S+/i;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const CARD_RE = /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}\b/;

export function hasSensitiveShape(value: string): boolean {
  return (
    SCHEME_RE.test(value) ||
    JWT_RE.test(value) ||
    SSN_RE.test(value) ||
    CARD_RE.test(value)
  );
}

export function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const marker = "…";
  if (max <= marker.length) return text.slice(0, max);
  return text.slice(0, max - marker.length) + marker;
}

export function redactValue(
  value: unknown,
  policy: RedactionPolicy,
  depth: number = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") {
    return masksShape(value, policy) ? REDACTED : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "<circular>";
  if (depth >= policy.maxDepth) return "<depth limit>";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = value
        .slice(0, policy.maxArrayItems)
        .map((item) => redactValue(item, policy, depth + 1, seen));
      if (value.length > policy.maxArrayItems) {
        items.push(`<${value.length - policy.maxArrayItems} more items>`);
      }
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isAllowedKey(key, policy)) {
        out[key] = item;
      } else if (isDeniedKey(key, policy)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactValue(item, policy, depth + 1, seen);
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function redactRecord(
  entry: Record<string, unknown>,
  policy: RedactionPolicy,
): Record<string, unknown> {
  const result = redactValue(entry, policy);
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return {};
}

export function redactStringMap(
  map: Record<string, string | undefined> | undefined,
  policy: RedactionPolicy,
  lowercaseKeys: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!map) return out;
  for (const [key, value] of Object.entries(map)) {
    if (value == null) continue;
    const name = lowercaseKeys ? key.toLowerCase() : key;
    if (isAllowedKey(key, policy)) {
      out[name] = value;
      continue;
    }
    out[name] =
      isDeniedKey(key, policy) || masksShape(value, policy) ? REDACTED : value;
  }
  return out;
}

export function redactHeaders(
  headers: Record<string, string | undefined> | undefined,
  policy: RedactionPolicy,
): Record<string, string> {
  return redactStringMap(headers, policy, true);
}

const FORM_RE = /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/;

export function redactBody(
  raw: string | undefined,
  isBase64: boolean,
  policy: RedactionPolicy,
): string | undefined {
  if (raw == null || raw.length === 0) return undefined;

  let text = raw;
  if (isBase64) {
    const buf = Buffer.from(raw, "base64");
    text = buf.toString("utf-8");
    if (text.includes("�")) return `<binary, ${buf.length} bytes>`;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return clip(
        JSON.stringify(redactValue(parsed, policy)),
        policy.maxBodyChars,
      );
    } catch {}
  }

  if (FORM_RE.test(trimmed)) {
    const params = new URLSearchParams(trimmed);
    const parts: string[] = [];
    for (const [key, value] of params) {
      const safe = isAllowedKey(key, policy)
        ? value
        : isDeniedKey(key, policy) || masksShape(value, policy)
          ? REDACTED
          : value;
      parts.push(`${key}=${safe}`);
    }
    if (parts.length > 0) return clip(parts.join("&"), policy.maxBodyChars);
  }

  return clip(
    masksShape(trimmed, policy) ? REDACTED : trimmed,
    policy.maxBodyChars,
  );
}
