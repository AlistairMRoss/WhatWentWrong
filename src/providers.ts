export type AiProviderName = "anthropic" | "openai" | "grok" | "gemini";

export type AiWire = "anthropic" | "openai" | "gemini";

export interface ProviderSpec {
  readonly wire: AiWire;
  readonly defaultModel: string;
  readonly baseUrl: string;
  readonly keyHint: string;
  readonly maxTokensField: string;
  readonly outputTokenFloor: number;
}

export const PROVIDERS = {
  anthropic: {
    wire: "anthropic",
    defaultModel: "claude-haiku-4-5",
    baseUrl: "https://api.anthropic.com/v1",
    keyHint: "sk-ant-...",
    maxTokensField: "max_tokens",
    outputTokenFloor: 0,
  },
  openai: {
    wire: "openai",
    defaultModel: "gpt-5.6-luna",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "sk-...",
    maxTokensField: "max_completion_tokens",
    outputTokenFloor: 2048,
  },
  grok: {
    wire: "openai",
    defaultModel: "grok-4.5",
    baseUrl: "https://api.x.ai/v1",
    keyHint: "xai-...",
    maxTokensField: "max_tokens",
    outputTokenFloor: 2048,
  },
  gemini: {
    wire: "gemini",
    defaultModel: "gemini-3.5-flash-lite",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyHint: "AIza...",
    maxTokensField: "maxOutputTokens",
    outputTokenFloor: 2048,
  },
} as const satisfies Record<AiProviderName, ProviderSpec>;

export const AI_PROVIDER_NAMES = Object.keys(PROVIDERS) as AiProviderName[];

export const NO_ANALYSIS = "(no analysis returned)";

export const ANTHROPIC_API_VERSION = "2023-06-01";

export function isAiProviderName(value: string): value is AiProviderName {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

export function defaultModelFor(provider: AiProviderName): string {
  return PROVIDERS[provider].defaultModel;
}

export function keyHintFor(provider: AiProviderName): string {
  return PROVIDERS[provider].keyHint;
}

export interface AiRequestArgs {
  provider: AiProviderName;
  model: string;
  apiKey: string;
  systemPrompt: string;
  userContent: string;
  maxTokens: number;
  anthropicVersion: string;
}

export interface AiHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export function buildAiRequest(args: AiRequestArgs): AiHttpRequest {
  const spec = PROVIDERS[args.provider];
  const maxTokens = Math.max(args.maxTokens, spec.outputTokenFloor);

  switch (spec.wire) {
    case "anthropic":
      return {
        url: `${spec.baseUrl}/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": args.apiKey,
          "anthropic-version": args.anthropicVersion,
        },
        body: JSON.stringify({
          model: args.model,
          [spec.maxTokensField]: maxTokens,
          system: [
            {
              type: "text",
              text: args.systemPrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: args.userContent }],
        }),
      };

    case "openai":
      return {
        url: `${spec.baseUrl}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${args.apiKey}`,
        },
        body: JSON.stringify({
          model: args.model,
          [spec.maxTokensField]: maxTokens,
          messages: [
            { role: "system", content: args.systemPrompt },
            { role: "user", content: args.userContent },
          ],
        }),
      };

    case "gemini":
      return {
        url: `${spec.baseUrl}/models/${encodeURIComponent(args.model)}:generateContent`,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": args.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: args.systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: args.userContent }] }],
          generationConfig: { [spec.maxTokensField]: maxTokens },
        }),
      };
  }
}

export function parseAiResponse(
  provider: AiProviderName,
  data: unknown,
): string {
  const wire = PROVIDERS[provider].wire;
  const text =
    wire === "anthropic"
      ? parseAnthropicResponse(data)
      : wire === "openai"
        ? parseOpenAiResponse(data)
        : parseGeminiResponse(data);
  return text || NO_ANALYSIS;
}

function parseAnthropicResponse(data: unknown): string {
  const blocks = asArray(asRecord(data)?.content);
  if (!blocks) return "";
  const texts: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record?.type !== "text") continue;
    const text = asString(record.text);
    if (text) texts.push(text);
  }
  return texts.join("\n").trim();
}

function parseOpenAiResponse(data: unknown): string {
  const choices = asArray(asRecord(data)?.choices);
  const message = asRecord(asRecord(choices?.[0])?.message);
  return asString(message?.content)?.trim() ?? "";
}

function parseGeminiResponse(data: unknown): string {
  const candidates = asArray(asRecord(data)?.candidates);
  const content = asRecord(asRecord(candidates?.[0])?.content);
  const parts = asArray(content?.parts);
  if (!parts) return "";
  const texts: string[] = [];
  for (const part of parts) {
    const text = asString(asRecord(part)?.text);
    if (text) texts.push(text);
  }
  return texts.join("").trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? (value as unknown[]) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
