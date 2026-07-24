import { describe, expect, it } from "vitest";
import { ChannelType } from "discord.js";
import { paginateCharacterLines } from "../src/discord/bot.js";
import {
  isSupportedLobbyType,
  requiredLobbyPermissions
} from "../src/discord/transport.js";
import { parseExpression } from "../src/prompts.js";
import { redact, redactUnknown } from "../src/redaction.js";

describe("secret and reasoning hygiene", () => {
  it("redacts API keys, Discord tokens, authorization headers and reasoning", () => {
    const input =
      'Authorization: Bearer sk-secretsecretsecret {"groqApiKey":"gsk_abcdefghijklmnop","reasoning_content":"hidden chain"} abcdefghijklmnopqrstuv.abcdef.abcdefghijklmnopqrstuvwxyz';
    const output = redact(input);
    expect(output).not.toContain("secretsecret");
    expect(output).not.toContain("abcdefghijklmnop");
    expect(output).not.toContain("hidden chain");
    expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(output).toContain("[REDACTED]");
    expect(
      redactUnknown({
        headers: { authorization: "Bearer key" },
        thinking: "hidden",
        safe: "visible"
      })
    ).toEqual({
      headers: { authorization: "[REDACTED]" },
      thinking: "[REDACTED]",
      safe: "visible"
    });
  });

  it("strips and validates speech expression markers", () => {
    expect(
      parseExpression("[[SKY_EXPRESSION:calm]] Hello there.", true)
    ).toEqual({ content: "Hello there.", expression: "calm" });
    expect(
      parseExpression("[[SKY_EXPRESSION:execute_shell]] Hello.", true)
    ).toEqual({ content: "Hello." });
    expect(
      parseExpression("[[SKY_EXPRESSION:calm]] Hello.", false)
    ).toEqual({ content: "Hello." });
  });
});

describe("Discord lobby permissions", () => {
  it("requires the thread permission matching the lobby type", () => {
    expect(isSupportedLobbyType(ChannelType.GuildText)).toBe(true);
    expect(isSupportedLobbyType(ChannelType.GuildForum)).toBe(true);
    expect(isSupportedLobbyType(ChannelType.GuildAnnouncement)).toBe(false);
    expect(requiredLobbyPermissions(ChannelType.GuildForum)).toContain(
      "CreatePublicThreads"
    );
    expect(requiredLobbyPermissions(ChannelType.GuildForum)).not.toContain(
      "CreatePrivateThreads"
    );
    expect(requiredLobbyPermissions(ChannelType.GuildText)).toContain(
      "CreatePrivateThreads"
    );
    expect(requiredLobbyPermissions(ChannelType.GuildText)).toContain(
      "SendVoiceMessages"
    );
  });

  it("paginates character listings within Discord's message limit", () => {
    const pages = paginateCharacterLines(
      ["first character", "second character", "third character"],
      30
    );
    expect(pages).toEqual([
      "first character",
      "second character",
      "third character"
    ]);
    expect(pages.every((page) => page.length <= 30)).toBe(true);
  });
});
