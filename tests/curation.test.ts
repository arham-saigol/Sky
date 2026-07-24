import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterFiles } from "../src/characters.js";
import { CurationScheduler } from "../src/curation.js";
import {
  MAX_CURATION_MESSAGES,
  SkyDatabase
} from "../src/db.js";
import { KeyedMutex } from "../src/util/mutex.js";

const roots: string[] = [];
const dbs: SkyDatabase[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("dreamer and curator", () => {
  it("curates /end immediately, writes both files, and archives only after success", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sky-curate-"));
    roots.push(root);
    const db = new SkyDatabase(path.join(root, "sky.sqlite"));
    dbs.push(db);
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
      if (db.getSession(session.id)?.archived_at) break;
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

  it("drains bounded curation segments before ending the session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sky-curate-"));
    roots.push(root);
    const db = new SkyDatabase(path.join(root, "sky.sqlite"));
    dbs.push(db);
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
      threadId: "thread-segmented",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    for (let index = 0; index < MAX_CURATION_MESSAGES + 2; index++) {
      db.appendMessage({
        sessionId: session.id,
        discordMessageId: `segmented-${index}`,
        role: index % 2 === 0 ? "owner" : "assistant",
        content: `Message ${index}`,
        source: "text"
      });
    }
    const state = await characters.read(character);
    const provider = {
      curate: vi.fn().mockResolvedValue(
        JSON.stringify({
          soul_markdown: state.soul,
          memory_markdown: state.memory,
          summary: "Processed a bounded segment."
        })
      )
    };
    const archiver = {
      archiveAndLockThread: vi.fn().mockResolvedValue(undefined)
    };
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
      if (db.getSession(session.id)?.archived_at) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(provider.curate).toHaveBeenCalledTimes(2);
    expect(db.getSession(session.id)?.state).toBe("ended");
    expect(archiver.archiveAndLockThread).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("keeps malformed curation queued without ending or archiving", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sky-curate-"));
    roots.push(root);
    const db = new SkyDatabase(path.join(root, "sky.sqlite"));
    dbs.push(db);
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

  it("preserves human edits made while curation is in flight", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sky-curate-"));
    roots.push(root);
    const db = new SkyDatabase(path.join(root, "sky.sqlite"));
    dbs.push(db);
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
      threadId: "thread-edited",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    db.appendMessage({
      sessionId: session.id,
      discordMessageId: "owner-edited",
      role: "owner",
      content: "Remember this.",
      source: "text"
    });
    db.createCurationJob(session.id, "inactivity");
    const original = await characters.read(character);
    let releaseCuration: ((value: string) => void) | undefined;
    const providerResult = new Promise<string>((resolve) => {
      releaseCuration = resolve;
    });
    const provider = { curate: vi.fn().mockReturnValue(providerResult) };
    const scheduler = new CurationScheduler(
      db,
      characters,
      provider as never,
      { archiveAndLockThread: vi.fn() },
      pino({ enabled: false })
    );
    const tick = scheduler.tick();
    while (provider.curate.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const manualMemory =
      "# Persistent memory\n\n- A human edit made during curation.\n";
    await writeFile(character.memory_path, manualMemory);
    releaseCuration?.(
      JSON.stringify({
        soul_markdown: original.soul,
        memory_markdown: "# Persistent memory\n\n- Stale model output.\n",
        summary: "Stale result."
      })
    );
    await tick;
    expect(await readFile(character.memory_path, "utf8")).toBe(manualMemory);
    const job = db.raw
      .prepare("SELECT id FROM curation_jobs WHERE session_id = ?")
      .get(session.id) as { id: string };
    expect(db.getCurationJob(job.id)?.state).toBe("failed");
    expect(provider.curate).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("waits for in-flight thread work before snapshotting /end", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sky-curate-"));
    roots.push(root);
    const db = new SkyDatabase(path.join(root, "sky.sqlite"));
    dbs.push(db);
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
