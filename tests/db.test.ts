import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkyDatabase } from "../src/db.js";

const roots: string[] = [];
const dbs: SkyDatabase[] = [];

async function database(): Promise<{
  db: SkyDatabase;
  root: string;
  file: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sky-db-"));
  roots.push(root);
  const file = path.join(root, "sky.sqlite");
  const db = new SkyDatabase(file);
  dbs.push(db);
  return { db, root, file };
}

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("SQLite persistence and recovery", () => {
  it("migrates an empty database and restores binding, settings, deadlines and jobs", async () => {
    const { db, root, file } = await database();
    const character = db.createCharacter({
      name: "Mara",
      slug: "mara",
      soulPath: path.join(root, "SOUL.md"),
      memoryPath: path.join(root, "MEMORY.md"),
      voice: "Katie"
    });
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread-1",
      guildId: "guild-1",
      lobbyChannelId: "lobby-1"
    });
    db.updateSessionSettings(session.id, {
      speakMode: "mirror",
      modelId: "hy3",
      reasoningMode: "default"
    });
    db.appendMessage({
      sessionId: session.id,
      discordMessageId: "message-1",
      role: "owner",
      content: "Hello",
      source: "text",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    expect(db.enqueueDueInactivity("2026-01-01T00:31:00.000Z")).toBe(1);
    expect(db.pendingCurationCount()).toBe(1);
    db.close();

    const reopened = new SkyDatabase(file);
    dbs.push(reopened);
    expect(
      (
        reopened.raw
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get() as { version: number }
      ).version
    ).toBe(1);
    const restored = reopened.getSessionByThread("thread-1");
    expect(restored).toMatchObject({
      character_id: character.id,
      speak_mode: "mirror",
      model_id: "hy3",
      reasoning_mode: "default",
      curation_watermark_id: 0
    });
    expect(reopened.pendingCurationCount()).toBe(1);
    const job = reopened.claimDueCurationJob("2030-01-01T00:00:00.000Z");
    expect(job?.state).toBe("running");
    reopened.recoverInterruptedWork();
    const recovered = reopened.raw
      .prepare("SELECT state FROM curation_jobs WHERE id = ?")
      .get(job!.id) as { state: string };
    expect(recovered.state).toBe("failed");
    reopened.close();
  });

  it("deduplicates Discord events, messages and outbound work", async () => {
    const { db, root } = await database();
    const character = db.createCharacter({
      name: "Iris",
      slug: "iris",
      soulPath: path.join(root, "SOUL.md"),
      memoryPath: path.join(root, "MEMORY.md"),
      voice: "Gemma"
    });
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread-2",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    expect(db.claimEvent("event-1", "MESSAGE_CREATE")).toBe(true);
    expect(db.claimEvent("event-1", "MESSAGE_CREATE")).toBe(false);
    db.completeEvent("event-1");
    expect(db.claimEvent("event-1", "MESSAGE_CREATE")).toBe(false);
    expect(
      db.appendMessage({
        sessionId: session.id,
        discordMessageId: "event-1",
        role: "owner",
        content: "One",
        source: "text"
      }).inserted
    ).toBe(true);
    expect(
      db.appendMessage({
        sessionId: session.id,
        discordMessageId: "event-1",
        role: "owner",
        content: "Different duplicate",
        source: "text"
      }).inserted
    ).toBe(false);
    expect(db.beginOutbound("event-1", session.id, false).claimed).toBe(true);
    db.markOutboundGenerated("event-1", "Reply");
    expect(db.beginOutbound("event-1", session.id, false)).toMatchObject({
      claimed: true,
      existing: { clean_content: "Reply" }
    });
    const assistant = db.appendMessage({
      sessionId: session.id,
      discordMessageId: "response-1",
      role: "assistant",
      content: "Reply",
      source: "text",
      triggeringDiscordMessageId: "event-1"
    });
    db.markOutboundSent({
      triggerId: "event-1",
      responseDiscordId: "response-1",
      assistantRowId: assistant.row.id
    });
    expect(db.beginOutbound("event-1", session.id, false).claimed).toBe(false);
    expect(db.recentMessages(session.id, 10)).toHaveLength(2);
    db.close();
  });

  it("creates only one inactivity job for an unchanged segment", async () => {
    const { db, root } = await database();
    const character = db.createCharacter({
      name: "Nova",
      slug: "nova",
      soulPath: path.join(root, "SOUL.md"),
      memoryPath: path.join(root, "MEMORY.md"),
      voice: "Skylar"
    });
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    db.appendMessage({
      sessionId: session.id,
      discordMessageId: "m1",
      role: "owner",
      content: "A",
      source: "text",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    expect(db.enqueueDueInactivity("2026-01-01T00:31:00.000Z")).toBe(1);
    expect(db.enqueueDueInactivity("2026-01-01T01:01:00.000Z")).toBe(0);
    expect(
      (
        db.raw.prepare("SELECT COUNT(*) AS count FROM curation_jobs").get() as {
          count: number;
        }
      ).count
    ).toBe(1);
    db.close();
  });

  it("chains non-overlapping curation segments in watermark order", async () => {
    const { db, root } = await database();
    const character = db.createCharacter({
      name: "Chain",
      slug: "chain",
      soulPath: path.join(root, "SOUL.md"),
      memoryPath: path.join(root, "MEMORY.md"),
      voice: "Katie"
    });
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread-chain",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    db.appendMessage({
      sessionId: session.id,
      discordMessageId: "chain-1",
      role: "owner",
      content: "First",
      source: "text"
    });
    const first = db.createCurationJob(session.id, "inactivity")!;
    db.appendMessage({
      sessionId: session.id,
      discordMessageId: "chain-2",
      role: "owner",
      content: "Second",
      source: "text"
    });
    const second = db.createCurationJob(session.id, "end")!;
    expect(first).toMatchObject({ from_message_id: 0, to_message_id: 1 });
    expect(second).toMatchObject({ from_message_id: 1, to_message_id: 2 });
    const claimedFirst = db.claimDueCurationJob("2030-01-01T00:00:00.000Z");
    expect(claimedFirst?.id).toBe(first.id);
    db.completeCurationJob(claimedFirst!);
    const claimedSecond = db.claimDueCurationJob("2030-01-01T00:00:00.000Z");
    expect(claimedSecond?.id).toBe(second.id);
    db.close();
  });

  it("finds plain-text and voice work interrupted before generation", async () => {
    const { db, root } = await database();
    const character = db.createCharacter({
      name: "Recovery",
      slug: "recovery",
      soulPath: path.join(root, "SOUL.md"),
      memoryPath: path.join(root, "MEMORY.md"),
      voice: "Gemma"
    });
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread-recovery",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    db.appendMessage({
      sessionId: session.id,
      discordMessageId: "plain-interrupted",
      role: "owner",
      content: "Resume me",
      source: "text"
    });
    expect(db.incompleteOutbounds()).toEqual([
      {
        trigger_id: "plain-interrupted",
        session_id: session.id,
        source: "text"
      }
    ]);
    db.createAttachment({
      sessionId: session.id,
      discordMessageId: "voice-interrupted",
      discordAttachmentId: "attachment-interrupted",
      url: "https://cdn.discord.test/voice.ogg",
      contentType: "audio/ogg",
      filename: "voice.ogg",
      sizeBytes: 123
    });
    expect(db.incompleteVoiceInputs()).toMatchObject([
      {
        event_id: "voice-interrupted",
        session_id: session.id,
        attachment_id: "attachment-interrupted",
        thread_id: "thread-recovery"
      }
    ]);
    db.close();
  });
});
