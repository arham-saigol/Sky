import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { INACTIVITY_MS } from "./constants.js";
import type {
  ModelId,
  SpeakMode,
  VoiceName
} from "./constants.js";

export interface CharacterRow {
  id: string;
  name: string;
  name_key: string;
  slug: string;
  soul_path: string;
  memory_path: string;
  voice: VoiceName;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SessionRow {
  id: string;
  character_id: string;
  thread_id: string;
  guild_id: string;
  lobby_channel_id: string;
  state: "active" | "ending" | "ended";
  accepting_messages: 0 | 1;
  speak_mode: SpeakMode;
  model_id: ModelId;
  reasoning_mode: string;
  started_at: string;
  last_activity_at: string | null;
  inactivity_deadline_at: string | null;
  curation_watermark_id: number;
  ended_at: string | null;
  archived_at: string | null;
}

export interface MessageRow {
  id: number;
  session_id: string;
  discord_message_id: string;
  role: "owner" | "assistant";
  content: string;
  source: "text" | "voice";
  triggering_discord_message_id: string | null;
  created_at: string;
}

export interface CurationJobRow {
  id: string;
  session_id: string;
  character_id: string;
  from_message_id: number;
  to_message_id: number;
  trigger: "inactivity" | "end";
  segment_digest: string;
  state: "pending" | "running" | "succeeded" | "failed";
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewCharacter {
  id?: string;
  name: string;
  slug: string;
  soulPath: string;
  memoryPath: string;
  voice: VoiceName;
}

export interface NewSession {
  id?: string;
  characterId: string;
  threadId: string;
  guildId: string;
  lobbyChannelId: string;
}

export const MAX_CURATION_MESSAGES = 20;
export const MAX_CURATION_TRANSCRIPT_BYTES = 48 * 1024;

function now(): string {
  return new Date().toISOString();
}

export class SkyDatabase {
  public readonly raw: Database.Database;

  public constructor(
    databasePath: string,
    migrationDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "migrations"
    )
  ) {
    this.raw = new Database(databasePath);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.raw.pragma("synchronous = FULL");
    this.raw.pragma("busy_timeout = 5000");
    this.migrate(migrationDir);
  }

  public close(): void {
    if (this.raw.open) {
      this.raw.pragma("wal_checkpoint(TRUNCATE)");
      this.raw.close();
    }
  }

  public health(): { ok: boolean; detail: string } {
    try {
      const result = this.raw.pragma("quick_check") as Array<{
        quick_check: string;
      }>;
      const ok = result.length === 1 && result[0]?.quick_check === "ok";
      return { ok, detail: ok ? "SQLite quick_check passed" : JSON.stringify(result) };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "SQLite check failed"
      };
    }
  }

  private migrate(migrationDir: string): void {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
    );
    const applied = new Set(
      (
        this.raw
          .prepare("SELECT version FROM schema_migrations")
          .all() as Array<{ version: number }>
      ).map((row) => row.version)
    );
    const files = readdirSync(migrationDir)
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const version = Number.parseInt(file.split("_")[0] ?? "", 10);
      if (applied.has(version)) continue;
      const sql = readFileSync(path.join(migrationDir, file), "utf8");
      this.raw.transaction(() => {
        this.raw.exec(sql);
        this.raw
          .prepare(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)"
          )
          .run(version, file, now());
      })();
    }
  }

  public createCharacter(input: NewCharacter): CharacterRow {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    this.raw
      .prepare(
        `INSERT INTO characters
         (id, name, name_key, slug, soul_path, memory_path, voice, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.name.trim().toLocaleLowerCase("en-US"),
        input.slug,
        input.soulPath,
        input.memoryPath,
        input.voice,
        timestamp,
        timestamp
      );
    return this.getCharacterById(id)!;
  }

  public listCharacters(): CharacterRow[] {
    return this.raw
      .prepare(
        "SELECT * FROM characters WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE"
      )
      .all() as CharacterRow[];
  }

  public getCharacterByName(name: string): CharacterRow | undefined {
    return this.raw
      .prepare(
        "SELECT * FROM characters WHERE name_key = ? AND deleted_at IS NULL"
      )
      .get(name.trim().toLocaleLowerCase("en-US")) as CharacterRow | undefined;
  }

  public getCharacterById(id: string): CharacterRow | undefined {
    return this.raw
      .prepare("SELECT * FROM characters WHERE id = ? AND deleted_at IS NULL")
      .get(id) as CharacterRow | undefined;
  }

  public softDeleteCharacter(id: string): void {
    const timestamp = now();
    this.raw
      .prepare(
        "UPDATE characters SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
      .run(timestamp, timestamp, id);
  }

  public permanentlyDeleteCharacter(id: string): void {
    if (this.activeSessionCountForCharacter(id) > 0) {
      throw new Error("Cannot delete a character with active sessions");
    }
    this.raw.transaction(() => {
      this.raw
        .prepare(
          `DELETE FROM attachments WHERE session_id IN (
             SELECT id FROM sessions WHERE character_id = ?
           )`
        )
        .run(id);
      this.raw
        .prepare(
          `DELETE FROM outbound_responses WHERE session_id IN (
             SELECT id FROM sessions WHERE character_id = ?
           )`
        )
        .run(id);
      this.raw
        .prepare("DELETE FROM file_revisions WHERE character_id = ?")
        .run(id);
      this.raw
        .prepare("DELETE FROM curation_jobs WHERE character_id = ?")
        .run(id);
      this.raw
        .prepare("DELETE FROM thread_bindings WHERE character_id = ?")
        .run(id);
      this.raw
        .prepare(
          `DELETE FROM messages WHERE session_id IN (
             SELECT id FROM sessions WHERE character_id = ?
           )`
        )
        .run(id);
      this.raw
        .prepare("DELETE FROM sessions WHERE character_id = ?")
        .run(id);
      this.raw.prepare("DELETE FROM characters WHERE id = ?").run(id);
    })();
  }

  public attachmentPathsForCharacter(id: string): string[] {
    return (
      this.raw
        .prepare(
          `SELECT attachments.local_path FROM attachments
           JOIN sessions ON sessions.id = attachments.session_id
           WHERE sessions.character_id = ? AND attachments.local_path IS NOT NULL`
        )
        .all(id) as Array<{ local_path: string }>
    ).map((row) => row.local_path);
  }

  public setCharacterVoice(id: string, voice: VoiceName): void {
    this.raw
      .prepare(
        "UPDATE characters SET voice = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
      .run(voice, now(), id);
  }

  public activeSessionCountForCharacter(id: string): number {
    const row = this.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE character_id = ? AND state != 'ended'"
      )
      .get(id) as { count: number };
    return row.count;
  }

  public createSession(input: NewSession): SessionRow {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    this.raw.transaction(() => {
      this.raw
        .prepare(
          `INSERT INTO sessions
           (id, character_id, thread_id, guild_id, lobby_channel_id, state, accepting_messages, started_at)
           VALUES (?, ?, ?, ?, ?, 'active', 1, ?)`
        )
        .run(
          id,
          input.characterId,
          input.threadId,
          input.guildId,
          input.lobbyChannelId,
          timestamp
        );
      this.raw
        .prepare(
          `INSERT INTO thread_bindings(thread_id, character_id, session_id, guild_id, bound_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          input.threadId,
          input.characterId,
          id,
          input.guildId,
          timestamp
        );
    })();
    return this.getSession(id)!;
  }

  public getSession(id: string): SessionRow | undefined {
    return this.raw
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
  }

  public getSessionByThread(threadId: string): SessionRow | undefined {
    return this.raw
      .prepare("SELECT * FROM sessions WHERE thread_id = ?")
      .get(threadId) as SessionRow | undefined;
  }

  public updateSessionSettings(
    id: string,
    settings: Partial<{
      speakMode: SpeakMode;
      modelId: ModelId;
      reasoningMode: string;
    }>
  ): void {
    if (settings.speakMode !== undefined) {
      this.raw
        .prepare("UPDATE sessions SET speak_mode = ? WHERE id = ?")
        .run(settings.speakMode, id);
    }
    if (settings.modelId !== undefined) {
      this.raw
        .prepare(
          "UPDATE sessions SET model_id = ?, reasoning_mode = 'default' WHERE id = ?"
        )
        .run(settings.modelId, id);
    }
    if (settings.reasoningMode !== undefined) {
      this.raw
        .prepare("UPDATE sessions SET reasoning_mode = ? WHERE id = ?")
        .run(settings.reasoningMode, id);
    }
  }

  public beginEndSession(id: string): SessionRow {
    this.raw
      .prepare(
        `UPDATE sessions
         SET state = CASE WHEN state = 'active' THEN 'ending' ELSE state END,
             accepting_messages = 0,
             inactivity_deadline_at = NULL
         WHERE id = ?`
      )
      .run(id);
    return this.getSession(id)!;
  }

  public markSessionEnded(id: string): void {
    const timestamp = now();
    this.raw
      .prepare(
        `UPDATE sessions
         SET state = 'ended', accepting_messages = 0, ended_at = COALESCE(ended_at, ?),
             inactivity_deadline_at = NULL
         WHERE id = ?`
      )
      .run(timestamp, id);
  }

  public markArchived(id: string): void {
    this.raw
      .prepare(
        "UPDATE sessions SET archived_at = COALESCE(archived_at, ?) WHERE id = ?"
      )
      .run(now(), id);
  }

  public appendMessage(input: {
    sessionId: string;
    discordMessageId: string;
    role: "owner" | "assistant";
    content: string;
    source: "text" | "voice";
    triggeringDiscordMessageId?: string;
    createdAt?: string;
  }): { inserted: boolean; row: MessageRow } {
    const timestamp = input.createdAt ?? now();
    const result = this.raw.transaction(() => {
      const write = this.raw
        .prepare(
          `INSERT OR IGNORE INTO messages
           (session_id, discord_message_id, role, content, source, triggering_discord_message_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.sessionId,
          input.discordMessageId,
          input.role,
          input.content,
          input.source,
          input.triggeringDiscordMessageId ?? null,
          timestamp
        );
      if (write.changes > 0) {
        const deadline = new Date(
          new Date(timestamp).getTime() + INACTIVITY_MS
        ).toISOString();
        this.raw
          .prepare(
            `UPDATE sessions
             SET last_activity_at = ?, inactivity_deadline_at =
               CASE WHEN state = 'active' THEN ? ELSE NULL END
             WHERE id = ?`
          )
          .run(timestamp, deadline, input.sessionId);
      }
      return write.changes > 0;
    })();
    const row = this.raw
      .prepare("SELECT * FROM messages WHERE discord_message_id = ?")
      .get(input.discordMessageId) as MessageRow;
    return { inserted: result, row };
  }

  public recentMessages(sessionId: string, limit: number): MessageRow[] {
    return (
      this.raw
        .prepare(
          `SELECT * FROM (
             SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
           ) ORDER BY id`
        )
        .all(sessionId, limit) as MessageRow[]
    );
  }

  public messagesThroughTrigger(
    sessionId: string,
    triggerDiscordMessageId: string,
    limit: number
  ): MessageRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages
           WHERE session_id = ?
             AND id <= (
               SELECT id FROM messages
               WHERE session_id = ? AND discord_message_id = ?
             )
           ORDER BY id DESC LIMIT ?
         ) ORDER BY id`
      )
      .all(
        sessionId,
        sessionId,
        triggerDiscordMessageId,
        limit
      ) as MessageRow[];
  }

  public messagesInRange(
    sessionId: string,
    fromExclusive: number,
    toInclusive: number
  ): MessageRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND id > ? AND id <= ?
         ORDER BY id`
      )
      .all(sessionId, fromExclusive, toInclusive) as MessageRow[];
  }

  public claimEvent(eventId: string, eventType: string): boolean {
    const timestamp = now();
    return this.raw.transaction(() => {
      const existing = this.raw
        .prepare("SELECT status, updated_at FROM discord_events WHERE event_id = ?")
        .get(eventId) as { status: string; updated_at: string } | undefined;
      if (existing?.status === "completed") return false;
      if (
        existing?.status === "processing" &&
        Date.now() - new Date(existing.updated_at).getTime() < 10 * 60 * 1000
      )
        return false;
      if (existing) {
        this.raw
          .prepare(
            `UPDATE discord_events
             SET status = 'processing', attempts = attempts + 1, updated_at = ?
             WHERE event_id = ?`
          )
          .run(timestamp, eventId);
      } else {
        this.raw
          .prepare(
            `INSERT INTO discord_events
             (event_id, event_type, status, first_seen_at, updated_at)
             VALUES (?, ?, 'processing', ?, ?)`
          )
          .run(eventId, eventType, timestamp, timestamp);
      }
      return true;
    })();
  }

  public completeEvent(eventId: string): void {
    this.raw
      .prepare(
        "UPDATE discord_events SET status = 'completed', updated_at = ?, last_error = NULL WHERE event_id = ?"
      )
      .run(now(), eventId);
  }

  public failEvent(eventId: string, safeError: string): void {
    this.raw
      .prepare(
        "UPDATE discord_events SET status = 'failed', updated_at = ?, last_error = ? WHERE event_id = ?"
      )
      .run(now(), safeError.slice(0, 500), eventId);
  }

  public beginOutbound(
    triggerId: string,
    sessionId: string,
    voiceRequested: boolean
  ): {
    claimed: boolean;
    existing?: {
      state: string;
      clean_content: string | null;
      expression: string | null;
      discord_response_message_id: string | null;
    };
  } {
    const existing = this.raw
      .prepare(
        "SELECT * FROM outbound_responses WHERE triggering_discord_message_id = ?"
      )
      .get(triggerId) as
      | {
          state: string;
          clean_content: string | null;
          expression: string | null;
          discord_response_message_id: string | null;
        }
      | undefined;
    if (existing?.state === "sent") return { claimed: false, existing };
    if (existing) {
      this.raw
        .prepare(
          `UPDATE outbound_responses SET state =
             CASE WHEN clean_content IS NULL THEN 'generating' ELSE 'generated' END,
             voice_requested = ?, attempts = attempts + 1, updated_at = ?
           WHERE triggering_discord_message_id = ?`
        )
        .run(voiceRequested ? 1 : 0, now(), triggerId);
      return { claimed: true, existing };
    }
    this.raw
      .prepare(
        `INSERT INTO outbound_responses
         (triggering_discord_message_id, session_id, state, voice_requested, updated_at)
         VALUES (?, ?, 'generating', ?, ?)`
      )
      .run(triggerId, sessionId, voiceRequested ? 1 : 0, now());
    return { claimed: true };
  }

  public markOutboundGenerated(
    triggerId: string,
    content: string,
    expression?: string
  ): void {
    this.raw
      .prepare(
        `UPDATE outbound_responses
         SET state = 'generated', clean_content = ?, expression = ?, updated_at = ?
         WHERE triggering_discord_message_id = ?`
      )
      .run(content, expression ?? null, now(), triggerId);
  }

  public markOutboundSent(input: {
    triggerId: string;
    responseDiscordId: string;
    assistantRowId: number;
  }): void {
    this.raw
      .prepare(
        `UPDATE outbound_responses
         SET state = 'sent', discord_response_message_id = ?,
             assistant_message_row_id = ?, updated_at = ?, last_error = NULL
         WHERE triggering_discord_message_id = ?`
      )
      .run(
        input.responseDiscordId,
        input.assistantRowId,
        now(),
        input.triggerId
      );
  }

  public failOutbound(triggerId: string, safeError: string): void {
    this.raw
      .prepare(
        `UPDATE outbound_responses
         SET state = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?
         WHERE triggering_discord_message_id = ?`
      )
      .run(safeError.slice(0, 500), now(), triggerId);
  }

  public incompleteOutbounds(): Array<{
    trigger_id: string;
    session_id: string;
    source: "text" | "voice";
  }> {
    return this.raw
      .prepare(
        `SELECT m.discord_message_id AS trigger_id, m.session_id, m.source
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         LEFT JOIN outbound_responses o
           ON o.triggering_discord_message_id = m.discord_message_id
         WHERE m.role = 'owner' AND s.state = 'active'
           AND (o.triggering_discord_message_id IS NULL OR o.state != 'sent')
         ORDER BY m.id`
      )
      .all() as Array<{
      trigger_id: string;
      session_id: string;
      source: "text" | "voice";
    }>;
  }

  public incompleteVoiceInputs(): Array<{
    event_id: string;
    session_id: string;
    thread_id: string;
    guild_id: string;
    attachment_id: string;
    url: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    duration_seconds: number | null;
    waveform: string | null;
    created_at: string;
  }> {
    return this.raw
      .prepare(
        `SELECT a.discord_message_id AS event_id, a.session_id, s.thread_id, s.guild_id,
                a.discord_attachment_id AS attachment_id, a.url, a.filename,
                COALESCE(a.content_type, 'application/octet-stream') AS content_type,
                a.size_bytes, a.duration_seconds, a.waveform, a.created_at
         FROM attachments a
         JOIN sessions s ON s.id = a.session_id
         LEFT JOIN messages m ON m.discord_message_id = a.discord_message_id
         WHERE s.state = 'active' AND m.id IS NULL
         ORDER BY a.created_at`
      )
      .all() as Array<{
      event_id: string;
      session_id: string;
      thread_id: string;
      guild_id: string;
      attachment_id: string;
      url: string;
      filename: string;
      content_type: string;
      size_bytes: number;
      duration_seconds: number | null;
      waveform: string | null;
      created_at: string;
    }>;
  }

  public createAttachment(input: {
    id?: string;
    sessionId: string;
    discordMessageId: string;
    discordAttachmentId: string;
    url: string;
    contentType?: string;
    filename: string;
    sizeBytes: number;
    durationSeconds?: number;
    waveform?: string;
  }): string {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO attachments
         (id, session_id, discord_message_id, discord_attachment_id, url, content_type, filename,
          size_bytes, duration_seconds, waveform, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        id,
        input.sessionId,
        input.discordMessageId,
        input.discordAttachmentId,
        input.url,
        input.contentType ?? null,
        input.filename,
        input.sizeBytes,
        input.durationSeconds ?? null,
        input.waveform ?? null,
        timestamp,
        timestamp
      );
    const row = this.raw
      .prepare(
        "SELECT id FROM attachments WHERE discord_attachment_id = ?"
      )
      .get(input.discordAttachmentId) as { id: string };
    return row.id;
  }

  public updateAttachment(
    id: string,
    update: {
      status:
        | "pending"
        | "downloading"
        | "transcribing"
        | "completed"
        | "failed";
      localPath?: string;
      transcript?: string;
      safeError?: string;
      incrementAttempts?: boolean;
    }
  ): void {
    this.raw
      .prepare(
        `UPDATE attachments
         SET status = ?, local_path = COALESCE(?, local_path),
             transcript = COALESCE(?, transcript), last_error = ?,
             attempts = attempts + ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        update.status,
        update.localPath ?? null,
        update.transcript ?? null,
        update.safeError?.slice(0, 500) ?? null,
        update.incrementAttempts ? 1 : 0,
        now(),
        id
      );
  }

  public getAttachmentByDiscordId(discordAttachmentId: string):
    | {
        id: string;
        status: string;
        local_path: string | null;
        transcript: string | null;
      }
    | undefined {
    return this.raw
      .prepare(
        "SELECT id, status, local_path, transcript FROM attachments WHERE discord_attachment_id = ?"
      )
      .get(discordAttachmentId) as
      | {
          id: string;
          status: string;
          local_path: string | null;
          transcript: string | null;
        }
      | undefined;
  }

  public createCurationJob(
    sessionId: string,
    trigger: "inactivity" | "end"
  ): CurationJobRow | undefined {
    return this.raw.transaction(() => {
      const session = this.getSession(sessionId);
      if (!session) return undefined;
      const reserved = this.raw
        .prepare(
          `SELECT COALESCE(MAX(to_message_id), ?) AS reserved_to
           FROM curation_jobs WHERE session_id = ?`
        )
        .get(session.curation_watermark_id, sessionId) as {
        reserved_to: number;
      };
      const from = Math.max(
        session.curation_watermark_id,
        reserved.reserved_to
      );
      const candidates = this.raw
        .prepare(
          `SELECT * FROM messages
           WHERE session_id = ? AND id > ?
           ORDER BY id
           LIMIT ?`
        )
        .all(sessionId, from, MAX_CURATION_MESSAGES) as MessageRow[];
      const messages: MessageRow[] = [];
      let transcriptBytes = 0;
      for (const message of candidates) {
        const messageBytes = Buffer.byteLength(
          `${message.role}\0${message.content}`,
          "utf8"
        );
        if (
          messages.length > 0 &&
          transcriptBytes + messageBytes > MAX_CURATION_TRANSCRIPT_BYTES
        ) {
          break;
        }
        messages.push(message);
        transcriptBytes += messageBytes;
      }
      if (messages.length === 0) return undefined;
      const to = messages.at(-1)!.id;
      const digest = createHash("sha256")
        .update(
          messages
            .map((message) => `${message.id}\0${message.role}\0${message.content}`)
            .join("\n")
        )
        .digest("hex");
      const id = randomUUID();
      const timestamp = now();
      this.raw
        .prepare(
          `INSERT OR IGNORE INTO curation_jobs
           (id, session_id, character_id, from_message_id, to_message_id, trigger,
            segment_digest, state, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
        )
        .run(
          id,
          sessionId,
          session.character_id,
          from,
          to,
          trigger,
          digest,
          timestamp,
          timestamp,
          timestamp
        );
      return this.raw
        .prepare(
          `SELECT * FROM curation_jobs
           WHERE session_id = ? AND from_message_id = ? AND to_message_id = ?`
        )
        .get(sessionId, from, to) as CurationJobRow;
    })();
  }

  public enqueueDueInactivity(at = now()): number {
    const due = this.raw
      .prepare(
        `SELECT id FROM sessions
         WHERE state = 'active' AND inactivity_deadline_at IS NOT NULL
           AND inactivity_deadline_at <= ?
           AND EXISTS (
             SELECT 1 FROM messages
             WHERE messages.session_id = sessions.id
               AND messages.id > sessions.curation_watermark_id
           )`
      )
      .all(at) as Array<{ id: string }>;
    let created = 0;
    for (const row of due) {
      if (this.createCurationJob(row.id, "inactivity")) created++;
      this.raw
        .prepare(
          "UPDATE sessions SET inactivity_deadline_at = NULL WHERE id = ?"
        )
        .run(row.id);
    }
    return created;
  }

  public claimDueCurationJob(at = now()): CurationJobRow | undefined {
    return this.raw.transaction(() => {
      const job = this.raw
        .prepare(
          `SELECT curation_jobs.* FROM curation_jobs
           JOIN sessions ON sessions.id = curation_jobs.session_id
           WHERE curation_jobs.state IN ('pending', 'failed')
             AND curation_jobs.next_attempt_at <= ?
             AND curation_jobs.from_message_id = sessions.curation_watermark_id
           ORDER BY CASE trigger WHEN 'end' THEN 0 ELSE 1 END, created_at
           LIMIT 1`
        )
        .get(at) as CurationJobRow | undefined;
      if (!job) return undefined;
      this.raw
        .prepare(
          `UPDATE curation_jobs SET state = 'running', attempts = attempts + 1,
           updated_at = ? WHERE id = ?`
        )
        .run(now(), job.id);
      return {
        ...job,
        state: "running" as const,
        attempts: job.attempts + 1
      };
    })();
  }

  public getCurationJob(id: string): CurationJobRow | undefined {
    return this.raw
      .prepare("SELECT * FROM curation_jobs WHERE id = ?")
      .get(id) as CurationJobRow | undefined;
  }

  public recoverInterruptedWork(): void {
    const timestamp = now();
    this.raw
      .prepare(
        `UPDATE curation_jobs SET state = 'failed', next_attempt_at = ?,
         last_error = 'Service stopped while curation was running', updated_at = ?
         WHERE state = 'running'`
      )
      .run(timestamp, timestamp);
    this.raw
      .prepare(
        `UPDATE discord_events SET status = 'failed',
         last_error = 'Service stopped while event was processing', updated_at = ?
         WHERE status = 'processing'`
      )
      .run(timestamp);
  }

  public sessionsNeedingArchive(): SessionRow[] {
    return this.raw
      .prepare(
        "SELECT * FROM sessions WHERE state = 'ended' AND archived_at IS NULL"
      )
      .all() as SessionRow[];
  }

  public completeCurationJob(job: CurationJobRow): SessionRow {
    return this.raw.transaction(() => {
      this.raw
        .prepare(
          "UPDATE curation_jobs SET state = 'succeeded', last_error = NULL, updated_at = ? WHERE id = ?"
        )
        .run(now(), job.id);
      this.raw
        .prepare(
          `UPDATE sessions SET curation_watermark_id =
             CASE WHEN curation_watermark_id < ? THEN ? ELSE curation_watermark_id END
           WHERE id = ?`
        )
        .run(job.to_message_id, job.to_message_id, job.session_id);
      const session = this.getSession(job.session_id)!;
      const top = this.raw
        .prepare(
          "SELECT COALESCE(MAX(id), 0) AS max_id FROM messages WHERE session_id = ?"
        )
        .get(job.session_id) as { max_id: number };
      if (
        session.state === "ending" &&
        top.max_id <= Math.max(session.curation_watermark_id, job.to_message_id)
      ) {
        this.markSessionEnded(job.session_id);
      }
      return this.getSession(job.session_id)!;
    })();
  }

  public failCurationJob(job: CurationJobRow, safeError: string): void {
    const seconds = Math.min(3600, 15 * 2 ** Math.min(job.attempts - 1, 8));
    const next = new Date(Date.now() + seconds * 1000).toISOString();
    this.raw
      .prepare(
        `UPDATE curation_jobs
         SET state = 'failed', last_error = ?, next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND state != 'succeeded'`
      )
      .run(safeError.slice(0, 500), next, now(), job.id);
  }

  public pendingCurationCount(): number {
    const row = this.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM curation_jobs WHERE state IN ('pending', 'running', 'failed')"
      )
      .get() as { count: number };
    return row.count;
  }

  public pendingCurationCountForSession(sessionId: string): number {
    const row = this.raw
      .prepare(
        `SELECT COUNT(*) AS count FROM curation_jobs
         WHERE session_id = ? AND state IN ('pending', 'running', 'failed')`
      )
      .get(sessionId) as { count: number };
    return row.count;
  }

  public expediteCurationForEnd(sessionId: string): void {
    const timestamp = now();
    this.raw
      .prepare(
        `UPDATE curation_jobs SET trigger = 'end', next_attempt_at = ?, updated_at = ?
         WHERE session_id = ? AND state IN ('pending', 'failed')`
      )
      .run(timestamp, timestamp, sessionId);
  }

  public recordRevision(input: {
    characterId: string;
    kind: "SOUL" | "MEMORY";
    sha256: string;
    content: string;
    source: "create" | "curator" | "external";
    curationJobId?: string;
  }): number {
    const row = this.raw
      .prepare(
        "SELECT COALESCE(MAX(revision), 0) AS revision FROM file_revisions WHERE character_id = ? AND file_kind = ?"
      )
      .get(input.characterId, input.kind) as { revision: number };
    const revision = row.revision + 1;
    this.raw
      .prepare(
        `INSERT INTO file_revisions
         (character_id, file_kind, revision, sha256, content, source, curation_job_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.characterId,
        input.kind,
        revision,
        input.sha256,
        input.content,
        input.source,
        input.curationJobId ?? null,
        now()
      );
    return revision;
  }

  public latestRevision(
    characterId: string,
    kind: "SOUL" | "MEMORY"
  ):
    | { revision: number; sha256: string; content: string; source: string }
    | undefined {
    return this.raw
      .prepare(
        `SELECT revision, sha256, content, source FROM file_revisions
         WHERE character_id = ? AND file_kind = ?
         ORDER BY revision DESC LIMIT 1`
      )
      .get(characterId, kind) as
      | { revision: number; sha256: string; content: string; source: string }
      | undefined;
  }

  public saveModelCapabilities(
    modelId: ModelId,
    modes: string[],
    source: string
  ): void {
    this.raw
      .prepare(
        `INSERT INTO model_capabilities(model_id, reasoning_modes_json, source, checked_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(model_id) DO UPDATE SET
           reasoning_modes_json = excluded.reasoning_modes_json,
           source = excluded.source,
           checked_at = excluded.checked_at`
      )
      .run(modelId, JSON.stringify(modes), source, now());
  }

  public getModelCapabilities(
    modelId: ModelId
  ): { modes: string[]; source: string; checkedAt: string } | undefined {
    const row = this.raw
      .prepare("SELECT * FROM model_capabilities WHERE model_id = ?")
      .get(modelId) as
      | {
          reasoning_modes_json: string;
          source: string;
          checked_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      modes: JSON.parse(row.reasoning_modes_json) as string[],
      source: row.source,
      checkedAt: row.checked_at
    };
  }

  public setServiceState(key: string, value: unknown): void {
    this.raw
      .prepare(
        `INSERT INTO service_state(key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), now());
  }

  public getServiceState<T>(key: string): T | undefined {
    const row = this.raw
      .prepare("SELECT value_json FROM service_state WHERE key = ?")
      .get(key) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  public recordHealth(component: string, ok: boolean, detail: string): void {
    this.raw
      .prepare(
        `INSERT INTO health_checks(component, ok, detail, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(component) DO UPDATE SET ok = excluded.ok, detail = excluded.detail,
         checked_at = excluded.checked_at`
      )
      .run(component, ok ? 1 : 0, detail.slice(0, 1000), now());
  }
}
