import { describe, expect, test } from "bun:test";
import {
  AI_PROVIDER_NAMES,
  NO_ANALYSIS,
  PROVIDERS,
  buildAiRequest,
  defaultModelFor,
  isAiProviderName,
  keyHintFor,
  parseAiResponse,
  type AiProviderName,
} from "./providers.js";

const BASE = {
  apiKey: "test-key",
  systemPrompt: "SYSTEM",
  userContent: "<log_data>\nboom\n</log_data>",
  maxTokens: 400,
  anthropicVersion: "2023-06-01",
};

function request(provider: AiProviderName, model = "test-model") {
  const built = buildAiRequest({ ...BASE, provider, model });
  return { ...built, json: JSON.parse(built.body) as Record<string, any> };
}

describe("provider table", () => {
  test("exposes exactly the four supported providers", () => {
    expect(AI_PROVIDER_NAMES.sort()).toEqual([
      "anthropic",
      "gemini",
      "grok",
      "openai",
    ]);
  });

  test.each(AI_PROVIDER_NAMES)("%s has a non-empty default model", (name) => {
    expect(defaultModelFor(name)).toBeTruthy();
    expect(keyHintFor(name)).toBeTruthy();
    expect(PROVIDERS[name].baseUrl.startsWith("https://")).toBe(true);
  });

  test("isAiProviderName narrows known names and rejects others", () => {
    expect(isAiProviderName("openai")).toBe(true);
    expect(isAiProviderName("llama")).toBe(false);
    expect(isAiProviderName("toString")).toBe(false);
  });
});

describe("buildAiRequest", () => {
  test("anthropic targets /v1/messages with x-api-key and a cached system block", () => {
    const { url, headers, json } = request("anthropic", "claude-haiku-4-5");
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
    expect(json.max_tokens).toBe(400);
    expect(json.system[0].text).toBe("SYSTEM");
    expect(json.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(json.messages).toEqual([
      { role: "user", content: BASE.userContent },
    ]);
  });

  test("openai targets chat/completions with a bearer token", () => {
    const { url, headers, json } = request("openai");
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer test-key");
    expect(json.messages).toEqual([
      { role: "system", content: "SYSTEM" },
      { role: "user", content: BASE.userContent },
    ]);
  });

  test("grok reuses the openai wire against api.x.ai", () => {
    const { url, headers, json } = request("grok");
    expect(url).toBe("https://api.x.ai/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer test-key");
    expect(json.messages[0].role).toBe("system");
  });

  test("openai uses max_completion_tokens and grok uses max_tokens", () => {
    expect(request("openai").json.max_completion_tokens).toBeDefined();
    expect(request("openai").json.max_tokens).toBeUndefined();
    expect(request("grok").json.max_tokens).toBeDefined();
    expect(request("grok").json.max_completion_tokens).toBeUndefined();
  });

  test("gemini puts the model in the path and the key in x-goog-api-key", () => {
    const { url, headers, json } = request("gemini", "gemini-3.5-flash-lite");
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    expect(headers["x-goog-api-key"]).toBe("test-key");
    expect(json.systemInstruction).toEqual({ parts: [{ text: "SYSTEM" }] });
    expect(json.contents).toEqual([
      { role: "user", parts: [{ text: BASE.userContent }] },
    ]);
    expect(json.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(400);
  });

  test("gemini model ids are path-escaped", () => {
    expect(request("gemini", "models/weird one").url).toContain(
      "models%2Fweird%20one:generateContent",
    );
  });

  test("reasoning providers get an output token floor, anthropic does not", () => {
    expect(request("openai").json.max_completion_tokens).toBe(2048);
    expect(request("grok").json.max_tokens).toBe(2048);
    expect(request("gemini").json.generationConfig.maxOutputTokens).toBe(2048);
    expect(request("anthropic").json.max_tokens).toBe(400);
  });

  test("an explicit budget above the floor is respected", () => {
    const built = buildAiRequest({
      ...BASE,
      provider: "openai",
      model: "m",
      maxTokens: 4000,
    });
    expect(JSON.parse(built.body).max_completion_tokens).toBe(4000);
  });

  test.each(AI_PROVIDER_NAMES)("%s always sends json content-type", (name) => {
    expect(request(name).headers["content-type"]).toBe("application/json");
  });
});

describe("parseAiResponse", () => {
  test("anthropic joins text blocks and skips non-text blocks", () => {
    const data = {
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: " Likely cause: x " },
        { type: "text", text: "Suggested fix: y" },
      ],
    };
    expect(parseAiResponse("anthropic", data)).toBe(
      "Likely cause: x \nSuggested fix: y",
    );
  });

  test("openai and grok read choices[0].message.content", () => {
    const data = { choices: [{ message: { content: "  answer  " } }] };
    expect(parseAiResponse("openai", data)).toBe("answer");
    expect(parseAiResponse("grok", data)).toBe("answer");
  });

  test("gemini concatenates every text part", () => {
    const data = {
      candidates: [
        { content: { parts: [{ text: "Likely " }, { text: "cause: x" }] } },
      ],
    };
    expect(parseAiResponse("gemini", data)).toBe("Likely cause: x");
  });

  test("gemini ignores non-text parts", () => {
    const data = {
      candidates: [
        {
          content: {
            parts: [{ thought: true }, { inlineData: {} }, { text: "ok" }],
          },
        },
      ],
    };
    expect(parseAiResponse("gemini", data)).toBe("ok");
  });

  test.each(AI_PROVIDER_NAMES)(
    "%s falls back to the no-analysis marker on empty or malformed data",
    (name) => {
      for (const data of [null, undefined, {}, [], "text", { content: [] }]) {
        expect(parseAiResponse(name, data)).toBe(NO_ANALYSIS);
      }
    },
  );

  test("whitespace-only content is treated as no analysis", () => {
    expect(
      parseAiResponse("openai", { choices: [{ message: { content: "   " } }] }),
    ).toBe(NO_ANALYSIS);
  });
});
