import { z } from "zod";
import type { Logger } from "pino";
import {
  CharacterFiles,
  MAX_CHARACTER_FILE_BYTES
} from "./characters.js";
import { SkyDatabase, type CurationJobRow } from "./db.js";
import { safeErrorMessage } from "./errors.js";
import type { OpenCodeProvider } from "./providers/opencode.js";
import {
  buildCuratorInput,
  CURATOR_SYSTEM
} from "./prompts.js";
import { KeyedMutex } from "./util/mutex.js";

const CuratorResponseSchema = z
  .object({
    soul_markdown: z.string().min(1).max(MAX_CHARACTER_FILE_BYTES),
    memory_markdown: z.string().min(1).max(MAX_CHARACTER_FILE_BYTES),
    summary: z.string().min(1).max(1_000)
  })
  .strict();

export interface ThreadArchiver {
  archiveAndLockThread(threadId: string): Promise<void>;
}

export class CurationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(
    private readonly db: SkyDatabase,
    private readonly characters: CharacterFiles,
    private readonly provider: Pick<OpenCodeProvider, "curate">,
    private readonly archiver: ThreadArchiver,
    private readonly logger: Logger,
    private readonly intervalMs = 15_000,
    private readonly sessions = new KeyedMutex()
  ) {}

  public start(): void {
    if (this.timer) return;
    this.db.recoverInterruptedWork();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  public async endSession(sessionId: string): Promise<{
    alreadyEnded: boolean;
    queued: boolean;
  }> {
    const before = this.db.getSession(sessionId);
    if (!before) throw new Error("Session not found");
    return await this.sessions.runExclusive(before.thread_id, async () => {
      const current = this.db.getSession(sessionId);
      if (!current) throw new Error("Session not found");
      if (current.state === "ended") {
        return { alreadyEnded: true, queued: false };
      }
      this.db.beginEndSession(sessionId);
      this.db.expediteCurationForEnd(sessionId);
      const job = this.db.createCurationJob(sessionId, "end");
      if (!job) {
        if (this.db.pendingCurationCountForSession(sessionId) > 0) {
          void this.tick();
          return { alreadyEnded: current.state === "ending", queued: true };
        }
        this.db.markSessionEnded(sessionId);
        await this.tryArchive(sessionId);
        return { alreadyEnded: false, queued: false };
      }
      void this.tick();
      return { alreadyEnded: current.state === "ending", queued: true };
    });
  }

  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.db.enqueueDueInactivity();
      let job: CurationJobRow | undefined;
      while ((job = this.db.claimDueCurationJob())) {
        await this.process(job);
      }
      for (const session of this.db.sessionsNeedingArchive()) {
        await this.tryArchive(session.id);
      }
    } finally {
      this.running = false;
    }
  }

  private async process(job: CurationJobRow): Promise<void> {
    try {
      const session = this.db.getSession(job.session_id);
      const character = this.db.getCharacterById(job.character_id);
      if (!session || !character) {
        throw new Error("Curation target no longer exists");
      }
      const state = await this.characters.read(character);
      const messages = this.db.messagesInRange(
        job.session_id,
        job.from_message_id,
        job.to_message_id
      );
      if (messages.length === 0) {
        throw new Error("Curation transcript segment is empty");
      }
      const raw = await this.provider.curate(
        CURATOR_SYSTEM,
        buildCuratorInput({
          ...state,
          messages,
          jobId: job.id,
          segmentDigest: job.segment_digest
        })
      );
      if (/^\s*```/.test(raw)) {
        throw new Error("Curator response used a code fence");
      }
      const parsed = CuratorResponseSchema.parse(JSON.parse(raw));
      await this.characters.applyCuration(
        character,
        job,
        {
          soul: parsed.soul_markdown,
          memory: parsed.memory_markdown
        },
        state
      );
      const updated = this.db.completeCurationJob(job);
      await this.characters.finalizeCuration(character, job);
      this.logger.info(
        {
          jobId: job.id,
          characterId: character.id,
          trigger: job.trigger,
          summary: parsed.summary
        },
        "Curation completed"
      );
      if (updated.state === "ended") await this.tryArchive(updated.id);
    } catch (error) {
      const safe = safeErrorMessage(error);
      this.db.failCurationJob(job, safe);
      this.logger.warn(
        { jobId: job.id, attempt: job.attempts, error: safe },
        "Curation failed and remains queued"
      );
    }
  }

  private async tryArchive(sessionId: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session || session.state !== "ended" || session.archived_at) return;
    try {
      await this.archiver.archiveAndLockThread(session.thread_id);
      this.db.markArchived(sessionId);
    } catch (error) {
      this.logger.warn(
        { sessionId, error: safeErrorMessage(error) },
        "Ended thread could not be archived yet"
      );
    }
  }
}
