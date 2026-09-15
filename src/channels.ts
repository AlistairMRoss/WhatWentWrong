export type WebhookChannel = "slack" | "discord";

const WEBHOOK_HOSTS: Record<WebhookChannel, string[]> = {
  slack: ["hooks.slack.com"],
  discord: [
    "discord.com",
    "discordapp.com",
    "ptb.discord.com",
    "canary.discord.com",
  ],
};

export function toList<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function checkWebhookUrl(
  url: string,
  channel: WebhookChannel,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Monitor: ${channel} webhook is not a valid URL: ${JSON.stringify(url)}`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `Monitor: ${channel} webhook must use https, got "${parsed.protocol}" in ${JSON.stringify(url)}`,
    );
  }
  const hosts = WEBHOOK_HOSTS[channel];
  if (!hosts.includes(parsed.hostname)) {
    return `Monitor: ${channel} webhook host "${parsed.hostname}" is unexpected (expected ${hosts.join(" or ")}); sending to it anyway.`;
  }
  return null;
}
