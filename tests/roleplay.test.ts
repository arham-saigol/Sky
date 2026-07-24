import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterFiles } from "../src/characters.js";
import { SkyDatabase } from "../src/db.js";
import { RoleplayEngine } from "../src/roleplay.js";

const roots: string[] = [];
const dbs: SkyDatabase[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sky-roleplay-"));
  roots.push(root);
  const db = new SkyDatabase(path.join(root, "sky.sqlite"));
  dbs.push(db);
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

  it("uses a separate nonce for failure notices before response recovery", async () => {
    const { root, db, characters } = await fixture();
    const openCode = {
      roleplay: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce({
          content: "Recovered reply.",
          actualModel: "deepseek-v4-pro",
          fellBack: false
        })
    };
    const sender = {
      sendText: vi
        .fn()
        .mockResolvedValueOnce("diagnostic-message")
        .mockResolvedValueOnce("assistant-recovered"),
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
    await engine.handle({
      eventId: "owner-failure",
      authorId: "owner",
      guildId: "guild",
      threadId: "thread",
      content: "Please retry",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    expect(sender.sendText.mock.calls[0]?.[2]).toBe("e-owner-failure");
    await engine.recoverIncomplete();
    expect(sender.sendText.mock.calls[1]?.[2]).toBe("owner-failure");
    expect(
      db.raw.prepare("SELECT role, content FROM messages ORDER BY id").all()
    ).toEqual([
      { role: "owner", content: "Please retry" },
      { role: "assistant", content: "Recovered reply." }
    ]);
    db.close();
  });

  it("serializes owner persistence with prompt generation per thread", async () => {
    const { root, db, characters } = await fixture();
    let releaseFirst: ((value: {
      content: string;
      actualModel: string;
      fellBack: boolean;
    }) => void) | undefined;
    const firstResult = new Promise<{
      content: string;
      actualModel: string;
      fellBack: boolean;
    }>((resolve) => {
      releaseFirst = resolve;
    });
    const openCode = {
      roleplay: vi
        .fn()
        .mockImplementationOnce(() => firstResult)
        .mockResolvedValueOnce({
          content: "Second reply.",
          actualModel: "deepseek-v4-pro",
          fellBack: false
        })
    };
    let response = 0;
    const sender = {
      sendText: vi.fn().mockImplementation(async () => `assistant-${++response}`),
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
    const first = engine.handle({
      eventId: "owner-1",
      authorId: "owner",
      guildId: "guild",
      threadId: "thread",
      content: "First message",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    while (openCode.roleplay.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const second = engine.handle({
      eventId: "owner-2",
      authorId: "owner",
      guildId: "guild",
      threadId: "thread",
      content: "Second message",
      createdAt: "2026-01-01T00:00:01.000Z"
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(openCode.roleplay).toHaveBeenCalledTimes(1);
    expect(
      db.raw.prepare("SELECT role, content FROM messages ORDER BY id").all()
    ).toEqual([{ role: "owner", content: "First message" }]);
    releaseFirst?.({
      content: "First reply.",
      actualModel: "deepseek-v4-pro",
      fellBack: false
    });
    await Promise.all([first, second]);
    expect(openCode.roleplay.mock.calls[0]?.[1].messages).toEqual([
      { role: "user", content: "First message" }
    ]);
    expect(openCode.roleplay.mock.calls[1]?.[1].messages).toEqual([
      { role: "user", content: "First message" },
      { role: "assistant", content: "First reply." },
      { role: "user", content: "Second message" }
    ]);
    expect(
      db.raw.prepare("SELECT role, content FROM messages ORDER BY id").all()
    ).toEqual([
      { role: "owner", content: "First message" },
      { role: "assistant", content: "First reply." },
      { role: "owner", content: "Second message" },
      { role: "assistant", content: "Second reply." }
    ]);
    db.close();
  });
});
