import { describe, expect, test } from "bun:test";
import { checkWebhookUrl, toList } from "./channels.js";

describe("toList", () => {
  test("normalises undefined, single values and arrays", () => {
    expect(toList(undefined)).toEqual([]);
    expect(toList(null)).toEqual([]);
    expect(toList("a@b.com")).toEqual(["a@b.com"]);
    expect(toList(["a@b.com", "c@d.com"])).toEqual(["a@b.com", "c@d.com"]);
    expect(toList([])).toEqual([]);
  });
});

describe("checkWebhookUrl", () => {
  test("accepts canonical slack and discord webhook urls without warning", () => {
    expect(
      checkWebhookUrl("https://hooks.slack.com/services/T/B/xyz", "slack"),
    ).toBeNull();
    expect(
      checkWebhookUrl("https://discord.com/api/webhooks/1/abc", "discord"),
    ).toBeNull();
    expect(
      checkWebhookUrl("https://discordapp.com/api/webhooks/1/abc", "discord"),
    ).toBeNull();
    expect(
      checkWebhookUrl("https://ptb.discord.com/api/webhooks/1/abc", "discord"),
    ).toBeNull();
  });

  test("warns but does not throw on an unexpected host", () => {
    const warning = checkWebhookUrl("https://example.com/hook", "slack");
    expect(warning).toContain("example.com");
    expect(warning).toContain("hooks.slack.com");
  });

  test("throws on a non-https url", () => {
    expect(() =>
      checkWebhookUrl("http://hooks.slack.com/services/T/B/xyz", "slack"),
    ).toThrow(/must use https/);
  });

  test("throws on an unparseable url", () => {
    expect(() => checkWebhookUrl("not-a-url", "discord")).toThrow(
      /not a valid URL/,
    );
    expect(() => checkWebhookUrl("", "slack")).toThrow(/not a valid URL/);
  });

  test("names the offending channel in the error", () => {
    expect(() => checkWebhookUrl("nope", "discord")).toThrow(/discord/);
    expect(() => checkWebhookUrl("nope", "slack")).toThrow(/slack/);
  });
});
