import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterFiles } from "../src/characters.js";
import { CurationScheduler } from "../src/curation.js";
import { SkyDatabase } from "../src/db.js";
import { KeyedMutex } from "../src/util/mutex.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("dreamer and curator", () => {
  it("curates /end immediately, writes both files, and archives only after success", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sky-curate-"));
    roots.push(root);
    const db = new SkyDatabase(path.join(root, "sky.sqlite"));
    const characters = new CharacterFiles(db, path.join(root, "characters"));
    await characters.initialize();
    const character = await characters.create({
      name: "Mara",
      identity: "A 29-year-old fictional adult.",
      personality: "Careful.",
      appearance: "An adult woman.",
      settingAndBoundaries: "Fictional, consensual.",
      voice: "Katie"
    });
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    db.appendMessage({
      sessionId: session.id,
      discordMessageId: "owner",
      role: "owner",
      content: "Remember that I love thunderstorms.",
      source: "text"
    });
    const currentSoul = await readFile(character.soul_path, "utf8");
    const provider = {
      curate: vi.fn().mockResolvedValue(
        JSON.stringify({
          soul_markdown: currentSoul,
          memory_markdown:
            "# Persistent memory\n\n- The owner loves thunderstorms.\n",
          summary: "Added a durable preference."
        })
      )
    };
    const archiver = { archiveAndLockThread: vi.fn().mockResolvedValue(undefined) };
    const scheduler = new CurationScheduler(
      db,
      characters,
      provider as never,
      archiver,
      pino({ enabled: false }),
      1_000_000
    );
    await scheduler.endSession(session.id);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (db.getSession(session.id)?.state === "ended") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(provider.curate).toHaveBeenCalledTimes(1);
    expect(await readFile(character.memory_path, "utf8")).toContain(
      "thunderstorms"
    );
    expect(db.getSession(session.id)).toMatchObject({
      state: "ended",
      accepting_messages: 0
    });
    expect(archiver.archiveAndLockThread).toHaveBeenCalledWith("thread");
    db.close();
  });

  it("keeps malformed curation queued without ending or archiving", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sky-curate-"));
    roots.push(root);
    const db = new SkyDatabase(path.join(root, "sky.sqlite"));
    const characters = new CharacterFiles(db, path.join(root, "characters"));
    await characters.initialize();
    const character = await characters.create({
      name: "Iris",
      identity: "A 31-year-old fictional adult.",
      personality: "Patient.",
      appearance: "An adult woman.",
      settingAndBoundaries: "Fictional, consensual.",
      voice: "Gemma"
    });
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread-fail",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    db.appendMessage({
      sessionId: session.id,
      discordMessageId: "owner-fail",
      role: "owner",
      content: "Remember this.",
      source: "text"
    });
    db.beginEndSession(session.id);
    db.createCurationJob(session.id, "end");
    const archiver = { archiveAndLockThread: vi.fn() };
    const scheduler = new CurationScheduler(
      db,
      characters,
      { curate: vi.fn().mockResolvedValue("not-json") } as never,
      archiver,
      pino({ enabled: false })
    );
    await scheduler.tick();
    expect(db.getSession(session.id)).toMatchObject({
      state: "ending",
      accepting_messages: 0
    });
    expect(db.pendingCurationCount()).toBe(1);
    expect(archiver.archiveAndLockThread).not.toHaveBeenCalled();
    db.close();
  });

  it("waits for in-flight thread work before snapshotting /end", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sky-curate-"));
    roots.push(root);
    const db = new SkyDatabase(path.join(root, "sky.sqlite"));
    const characters = new CharacterFiles(db, path.join(root, "characters"));
    await characters.initialize();
    const character = await characters.create({
      name: "Mara",
      identity: "A 29-year-old fictional adult.",
      personality: "Careful.",
      appearance: "An adult woman.",
      settingAndBoundaries: "Fictional, consensual.",
      voice: "Katie"
    });
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread-locked",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    const mutex = new KeyedMutex();
    let releaseWork: (() => void) | undefined;
    const workMayFinish = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const inFlight = mutex.runExclusive(session.thread_id, async () => {
      await workMayFinish;
      db.appendMessage({
        sessionId: session.id,
        discordMessageId: "owner-in-flight",
        role: "owner",
        content: "Last question.",
        source: "text"
      });
      db.appendMessage({
        sessionId: session.id,
        discordMessageId: "assistant-in-flight",
        role: "assistant",
        content: "Last answer.",
        source: "text",
        triggeringDiscordMessageId: "owner-in-flight"
      });
    });
    const currentSoul = await readFile(character.soul_path, "utf8");
    const provider = {
      curate: vi.fn().mockResolvedValue(
        JSON.stringify({
          soul_markdown: currentSoul,
          memory_markdown: "# Persistent memory\n\nLast answer retained.\n",
          summary: "Retained the final turn."
        })
      )
    };
    const scheduler = new CurationScheduler(
      db,
      characters,
      provider as never,
      { archiveAndLockThread: vi.fn().mockResolvedValue(undefined) },
      pino({ enabled: false }),
      1_000_000,
      mutex
    );
    const ending = scheduler.endSession(session.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(db.getSession(session.id)?.state).toBe("active");
    expect(provider.curate).not.toHaveBeenCalled();
    releaseWork?.();
    await inFlight;
    await ending;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (provider.curate.mock.calls.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(provider.curate.mock.calls[0]?.[1]).toContain("Last answer.");
    await scheduler.stop();
    db.close();
  });
});
