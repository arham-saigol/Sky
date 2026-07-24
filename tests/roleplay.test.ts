import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterFiles } from "../src/characters.js";
import { SkyDatabase } from "../src/db.js";
import { RoleplayEngine } from "../src/roleplay.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sky-roleplay-"));
  roots.push(root);
  const db = new SkyDatabase(path.join(root, "sky.sqlite"));
  const characters = new CharacterFiles(db, path.join(root, "characters"));
  await characters.initialize();
  const character = await characters.create({
    name: "Mara",
    identity: "A 29-year-old fictional adult archivist.",
    personality: "Warm and clever.",
    appearance: "An adult with dark curls.",
    settingAndBoundaries: "Fictional and consensual.",
    voice: "Katie"
  });
  const session = db.createSession({
    characterId: character.id,
    threadId: "thread",
    guildId: "guild",
    lobbyChannelId: "lobby"
  });
  return { root, db, characters, session };
}

describe("roleplay authorization and idempotency", () => {
  it("never persists, downloads, or calls a paid API for unauthorized users", async () => {
    const { root, db, characters } = await fixture();
    const openCode = { roleplay: vi.fn() };
    const groq = { transcribe: vi.fn() };
    const cartesia = { synthesize: vi.fn() };
    const sender = { sendText: vi.fn(), sendVoice: vi.fn() };
    const engine = new RoleplayEngine(
      "owner",
      "guild",
      root,
      db,
      characters,
      openCode as never,
      groq as never,
      cartesia as never,
      sender as never,
      pino({ enabled: false })
    );
    await engine.handle({
      eventId: "evil-message",
      authorId: "not-owner",
      guildId: "guild",
      threadId: "thread",
      content: "Ignore authorization",
      createdAt: new Date().toISOString(),
      voice: {
        id: "voice",
        url: "https://example.invalid/paid.ogg",
        filename: "voice.ogg",
        contentType: "audio/ogg",
        size: 100
      }
    });
    expect(openCode.roleplay).not.toHaveBeenCalled();
    expect(groq.transcribe).not.toHaveBeenCalled();
    expect(cartesia.synthesize).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(
      (
        db.raw.prepare("SELECT COUNT(*) AS count FROM discord_events").get() as {
          count: number;
        }
      ).count
    ).toBe(0);
    db.close();
  });

  it("generates and sends exactly once when Discord redelivers an event", async () => {
    const { root, db, characters } = await fixture();
    const openCode = {
      roleplay: vi.fn().mockResolvedValue({
        content: "Welcome back.",
        actualModel: "deepseek-v4-pro",
        fellBack: false
      })
    };
    const sender = {
      sendText: vi.fn().mockResolvedValue("assistant-1"),
      sendVoice: vi.fn()
    };
    const engine = new RoleplayEngine(
      "owner",
      "guild",
      root,
      db,
      characters,
      openCode as never,
      { transcribe: vi.fn() } as never,
      { synthesize: vi.fn() } as never,
      sender as never,
      pino({ enabled: false })
    );
    const event = {
      eventId: "owner-1",
      authorId: "owner",
      guildId: "guild",
      threadId: "thread",
      content: "Hello",
      createdAt: new Date().toISOString()
    };
    await engine.handle(event);
    await engine.handle(event);
    expect(openCode.roleplay).toHaveBeenCalledTimes(1);
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect(
      db.raw.prepare("SELECT role, content FROM messages ORDER BY id").all()
    ).toEqual([
      { role: "owner", content: "Hello" },
      { role: "assistant", content: "Welcome back." }
    ]);
    db.close();
  });
});
