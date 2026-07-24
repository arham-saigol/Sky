import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_CURATION_MESSAGES,
  MAX_CURATION_TRANSCRIPT_BYTES,
  SkyDatabase
} from "../src/db.js";

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
    ).toBe(2);
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

  it("persists one session result for a retried interaction", async () => {
    const { db, root } = await database();
    const character = db.createCharacter({
      name: "Idempotent",
      slug: "idempotent",
      soulPath: path.join(root, "SOUL.md"),
      memoryPath: path.join(root, "MEMORY.md"),
      voice: "Katie"
    });
    expect(db.claimEvent("start-interaction", "INTERACTION_2")).toBe(true);
    const first = db.createSessionForEvent("start-interaction", {
      characterId: character.id,
      threadId: "thread-first",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    const retried = db.createSessionForEvent("start-interaction", {
      characterId: character.id,
      threadId: "thread-duplicate",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    expect(retried.id).toBe(first.id);
    expect(retried.thread_id).toBe("thread-first");
    expect(db.getEventResultSession("start-interaction")?.id).toBe(first.id);
    expect(
      (
        db.raw.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
          count: number;
        }
      ).count
    ).toBe(1);
    db.close();
  });

  it("updates reasoning only for the model whose modes were validated", async () => {
    const { db, root } = await database();
    const character = db.createCharacter({
      name: "Reasoning",
      slug: "reasoning",
      soulPath: path.join(root, "SOUL.md"),
      memoryPath: path.join(root, "MEMORY.md"),
      voice: "Katie"
    });
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread-reasoning",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    expect(
      db.updateReasoningModeIfModel(session.id, "deepseek-v4-pro", "high")
    ).toBe(true);
    db.updateSessionSettings(session.id, { modelId: "hy3" });
    expect(
      db.updateReasoningModeIfModel(session.id, "deepseek-v4-pro", "low")
    ).toBe(false);
    expect(db.getSession(session.id)).toMatchObject({
      model_id: "hy3",
      reasoning_mode: "default"
    });
    db.close();
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

  it("bounds large curation backlogs into ordered segments", async () => {
    const { db, root } = await database();
    const character = db.createCharacter({
      name: "Bounded",
      slug: "bounded",
      soulPath: path.join(root, "SOUL.md"),
      memoryPath: path.join(root, "MEMORY.md"),
      voice: "Katie"
    });
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread-bounded",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    for (let index = 0; index < MAX_CURATION_MESSAGES + 2; index++) {
      db.appendMessage({
        sessionId: session.id,
        discordMessageId: `bounded-${index}`,
        role: index % 2 === 0 ? "owner" : "assistant",
        content: `Message ${index}`,
        source: "text"
      });
    }
    const first = db.createCurationJob(session.id, "end")!;
    expect(
      db.messagesInRange(
        session.id,
        first.from_message_id,
        first.to_message_id
      )
    ).toHaveLength(MAX_CURATION_MESSAGES);
    db.completeCurationJob(first);
    const second = db.createCurationJob(session.id, "end")!;
    expect(second.from_message_id).toBe(first.to_message_id);
    expect(
      db.messagesInRange(
        session.id,
        second.from_message_id,
        second.to_message_id
      )
    ).toHaveLength(2);

    const byteSession = db.createSession({
      characterId: character.id,
      threadId: "thread-byte-bounded",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    for (let index = 0; index < 2; index++) {
      db.appendMessage({
        sessionId: byteSession.id,
        discordMessageId: `byte-bounded-${index}`,
        role: index === 0 ? "owner" : "assistant",
        content: "x".repeat(MAX_CURATION_TRANSCRIPT_BYTES / 2 + 1),
        source: "text"
      });
    }
    const byteBounded = db.createCurationJob(byteSession.id, "end")!;
    expect(
      db.messagesInRange(
        byteSession.id,
        byteBounded.from_message_id,
        byteBounded.to_message_id
      )
    ).toHaveLength(1);

    const pairedSession = db.createSession({
      characterId: character.id,
      threadId: "thread-pair-bounded",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    db.appendMessage({
      sessionId: pairedSession.id,
      discordMessageId: "pair-prior-owner",
      role: "owner",
      content: "Prior question",
      source: "text"
    });
    db.appendMessage({
      sessionId: pairedSession.id,
      discordMessageId: "pair-prior-assistant",
      role: "assistant",
      content: "Prior answer",
      source: "text",
      triggeringDiscordMessageId: "pair-prior-owner"
    });
    db.appendMessage({
      sessionId: pairedSession.id,
      discordMessageId: "pair-large-owner",
      role: "owner",
      content: "o".repeat(30_000),
      source: "text"
    });
    db.appendMessage({
      sessionId: pairedSession.id,
      discordMessageId: "pair-large-assistant",
      role: "assistant",
      content: "a".repeat(30_000),
      source: "text",
      triggeringDiscordMessageId: "pair-large-owner"
    });
    const pairedFirst = db.createCurationJob(pairedSession.id, "end")!;
    expect(
      db.messagesInRange(
        pairedSession.id,
        pairedFirst.from_message_id,
        pairedFirst.to_message_id
      ).map((message) => message.discord_message_id)
    ).toEqual(["pair-prior-owner", "pair-prior-assistant"]);
    db.completeCurationJob(pairedFirst);
    const pairedSecond = db.createCurationJob(pairedSession.id, "end")!;
    expect(
      db.messagesInRange(
        pairedSession.id,
        pairedSecond.from_message_id,
        pairedSecond.to_message_id
      ).map((message) => message.discord_message_id)
    ).toEqual(["pair-large-owner", "pair-large-assistant"]);
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
