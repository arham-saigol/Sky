const AUTH_HEADER =
  /(authorization|x-api-key|anthropic-auth-token)\s*[:=]\s*(?:bearer\s+)?[^\s,;}"']+/gi;
const COMMON_KEYS =
  /\b(?:sk|gsk|pcsk|cartesia|opencode)[-_][A-Za-z0-9._-]{12,}\b/g;
const DISCORD_TOKEN =
  /\b(?:mfa\.[\w-]{20,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,})\b/g;
const JSON_SECRET =
  /("(?:api_?key|token|authorization|discordBotToken|openCodeApiKey|groqApiKey|cartesia(?:Primary|Backup)ApiKey)"\s*:\s*")[^"]*"/gi;
const REASONING_FIELDS =
  /("(?:reasoning_content|thinking|analysis|chain_of_thought)"\s*:\s*)("(?:\\.|[^"])*"|\{[\s\S]*?\}|\[[\s\S]*?\])/gi;

export function redact(input: string): string {
  return input
    .replace(AUTH_HEADER, "$1=[REDACTED]")
    .replace(COMMON_KEYS, "[REDACTED]")
    .replace(DISCORD_TOKEN, "[REDACTED]")
    .replace(JSON_SECRET, '$1[REDACTED]"')
    .replace(REASONING_FIELDS, '$1"[REDACTED]"');
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        /key|token|authorization|reasoning|thinking|analysis/i.test(key)
      ) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactUnknown(child);
      }
    }
    return result;
  }
  return value;
}
