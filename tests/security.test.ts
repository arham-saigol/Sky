import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelType } from "discord.js";
import { paginateCharacterLines } from "../src/discord/bot.js";
import {
  isSupportedLobbyType,
  requiredLobbyPermissions
} from "../src/discord/transport.js";
import { parseExpression } from "../src/prompts.js";
import { redact, redactUnknown } from "../src/redaction.js";
import {
  assertDedicatedDataDirectory,
  resolveSecretPromptAnswer
} from "../src/setup.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

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

  it("can explicitly clear an optional saved secret", () => {
    expect(resolveSecretPromptAnswer("", "existing", true)).toBe("existing");
    expect(resolveSecretPromptAnswer("replacement", "existing", true)).toBe(
      "replacement"
    );
    expect(resolveSecretPromptAnswer("CLEAR", "existing", true)).toBeUndefined();
  });

  it("refuses to take over a populated data directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sky-data-"));
    roots.push(root);
    await writeFile(path.join(root, "unrelated.txt"), "keep");

    await expect(assertDedicatedDataDirectory(root)).rejects.toThrow(
      "already contains files"
    );
    await expect(
      assertDedicatedDataDirectory(root, root)
    ).resolves.toBeUndefined();
    await expect(
      assertDedicatedDataDirectory(path.parse(root).root)
    ).rejects.toThrow("cannot be a drive or filesystem root");
  });
});

describe("Discord lobby permissions", () => {
  it("requires the thread permission matching the lobby type", () => {
    expect(isSupportedLobbyType(ChannelType.GuildText)).toBe(true);
    expect(isSupportedLobbyType(ChannelType.GuildForum)).toBe(false);
    expect(isSupportedLobbyType(ChannelType.GuildAnnouncement)).toBe(false);
    expect(requiredLobbyPermissions()).toContain("CreatePrivateThreads");
    expect(requiredLobbyPermissions()).toContain("SendVoiceMessages");
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
