import path from "node:path";
import type { Logger } from "pino";
import { downloadAudio, encodeDiscordVoice } from "./audio.js";
import { CharacterFiles } from "./characters.js";
import { MAX_RECENT_MESSAGES, type Expression } from "./constants.js";
import { SkyDatabase, type SessionRow } from "./db.js";
import { safeErrorMessage, SkyError } from "./errors.js";
import type { CartesiaTts } from "./providers/cartesia.js";
import type { GroqTranscriber } from "./providers/groq.js";
import type { OpenCodeProvider } from "./providers/opencode.js";
import { buildRoleplayPrompt, parseExpression } from "./prompts.js";
import { KeyedMutex } from "./util/mutex.js";

export interface InboundVoiceAttachment {
  id: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
  duration?: number;
  waveform?: string;
}

export interface InboundRoleplayMessage {
  eventId: string;
  authorId: string;
  guildId: string;
  threadId: string;
  content: string;
  createdAt: string;
  voice?: InboundVoiceAttachment;
}

export interface RoleplayDiscordSender {
  sendText(channelId: string, content: string, nonce: string): Promise<string>;
  sendVoice(
    channelId: string,
    voice: Awaited<ReturnType<typeof encodeDiscordVoice>>,
    nonce: string
  ): Promise<string>;
}

export class RoleplayEngine {
  private accepting = true;
  private active = 0;

  public constructor(
    private readonly ownerId: string,
    private readonly guildId: string,
    private readonly dataDir: string,
    private readonly db: SkyDatabase,
    private readonly characters: CharacterFiles,
    private readonly openCode: Pick<OpenCodeProvider, "roleplay">,
    private readonly groq: Pick<GroqTranscriber, "transcribe">,
    private readonly cartesia: Pick<CartesiaTts, "synthesize">,
    private readonly sender: RoleplayDiscordSender,
    private readonly logger: Logger,
    private readonly ffmpegPath?: string,
    private readonly threads = new KeyedMutex()
  ) {}

  public async handle(message: InboundRoleplayMessage): Promise<void> {
    // This check intentionally precedes persistence, attachment handling and every
    // paid-provider boundary.
    if (message.authorId !== this.ownerId || message.guildId !== this.guildId) {
      return;
    }
    if (!this.accepting) return;
    this.active++;
    try {
      await this.handleAuthorized(message);
    } finally {
      this.active--;
    }
  }

  public async stop(): Promise<void> {
    this.accepting = false;
    while (this.active > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async handleAuthorized(
    message: InboundRoleplayMessage
  ): Promise<void> {
    if (!this.db.getSessionByThread(message.threadId)) return;
    if (!this.db.claimEvent(message.eventId, "MESSAGE_CREATE")) return;
    try {
      await this.threads.runExclusive(message.threadId, async () => {
        const session = this.db.getSessionByThread(message.threadId);
        if (!session) return;
        if (session.state !== "active" || session.accepting_messages !== 1) {
          await this.sender.sendText(
            message.threadId,
            "This session has ended and no longer accepts roleplay messages.",
            message.eventId
          );
          this.db.completeEvent(message.eventId);
          return;
        }
        let content = message.content.trim();
        let source: "text" | "voice" = "text";
        if (message.voice) {
          source = "voice";
          content = await this.transcribeVoice(
            message,
            message.voice,
            session.id
          );
        }
        if (!content) {
          this.db.completeEvent(message.eventId);
          return;
        }
        const appended = this.db.appendMessage({
          sessionId: session.id,
          discordMessageId: message.eventId,
          role: "owner",
          content,
          source,
          createdAt: message.createdAt
        });
        await this.processTriggerLocked(
          session.id,
          appended.row.discord_message_id,
          source
        );
        this.db.completeEvent(message.eventId);
      });
    } catch (error) {
      const safe = safeErrorMessage(error);
      this.db.failEvent(message.eventId, safe);
      this.logger.warn(
        { threadId: message.threadId, eventId: message.eventId, error: safe },
        "Roleplay message processing failed"
      );
      await this.sender
        .sendText(
          message.threadId,
          `Sky could not process that message: ${safe}`,
          `e-${message.eventId}`
        )
        .catch(() => undefined);
    }
  }

  public async recoverIncomplete(
    maxAttempts = 3,
    baseDelayMs = 1_000
  ): Promise<void> {
    for (const input of this.db.incompleteVoiceInputs()) {
      await this.handle({
        eventId: input.event_id,
        authorId: this.ownerId,
        guildId: input.guild_id,
        threadId: input.thread_id,
        content: "",
        createdAt: input.created_at,
        voice: {
          id: input.attachment_id,
          url: input.url,
          filename: input.filename,
          contentType: input.content_type,
          size: input.size_bytes,
          ...(input.duration_seconds === null
            ? {}
            : { duration: input.duration_seconds }),
          ...(input.waveform === null ? {} : { waveform: input.waveform })
        }
      });
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const incomplete = this.db.incompleteOutbounds();
      if (incomplete.length === 0) return;
      for (const item of incomplete) {
        await this.processTrigger(
          item.session_id,
          item.trigger_id,
          item.source
        ).catch((error) => {
          this.logger.warn(
            {
              sessionId: item.session_id,
              triggerId: item.trigger_id,
              attempt,
              error: safeErrorMessage(error)
            },
            attempt < maxAttempts
              ? "Incomplete response recovery will retry"
              : "Incomplete response recovery exhausted startup retries"
          );
        });
      }
      if (
        attempt < maxAttempts &&
        this.db.incompleteOutbounds().length > 0
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1))
        );
      }
    }
  }

  private async transcribeVoice(
    message: InboundRoleplayMessage,
    attachment: InboundVoiceAttachment,
    sessionId: string
  ): Promise<string> {
    const existing = this.db.getAttachmentByDiscordId(attachment.id);
    if (existing?.status === "completed" && existing.transcript) {
      return existing.transcript;
    }
    const attachmentId = this.db.createAttachment({
      sessionId,
      discordMessageId: message.eventId,
      discordAttachmentId: attachment.id,
      url: attachment.url,
      contentType: attachment.contentType,
      filename: attachment.filename,
      sizeBytes: attachment.size,
      ...(attachment.duration === undefined
        ? {}
        : { durationSeconds: attachment.duration }),
      ...(attachment.waveform === undefined
        ? {}
        : { waveform: attachment.waveform })
    });
    this.db.updateAttachment(attachmentId, {
      status: "downloading",
      incrementAttempts: true
    });
    try {
      const localPath =
        existing?.local_path ??
        (await downloadAudio({
          url: attachment.url,
          contentType: attachment.contentType,
          expectedSize: attachment.size,
          targetDir: path.join(this.dataDir, "voice", "incoming"),
          basename: attachment.filename
        }));
      this.db.updateAttachment(attachmentId, {
        status: "transcribing",
        localPath
      });
      let transcript: string | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        this.db.updateAttachment(attachmentId, {
          status: "transcribing",
          localPath,
          incrementAttempts: true
        });
        try {
          transcript = await this.groq.transcribe(
            localPath,
            attachment.contentType
          );
          break;
        } catch (error) {
          lastError = error;
          if (!(error instanceof SkyError) || !error.retryable) break;
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * 2 ** attempt)
          );
        }
      }
      if (!transcript) throw lastError;
      this.db.updateAttachment(attachmentId, {
        status: "completed",
        localPath,
        transcript
      });
      return transcript;
    } catch (error) {
      this.db.updateAttachment(attachmentId, {
        status: "failed",
        safeError: safeErrorMessage(error)
      });
      throw error;
    }
  }

  private async processTrigger(
    sessionId: string,
    triggerId: string,
    ownerSource: "text" | "voice"
  ): Promise<void> {
    const initial = this.db.getSession(sessionId);
    if (!initial) return;
    await this.threads.runExclusive(initial.thread_id, async () => {
      await this.processTriggerLocked(sessionId, triggerId, ownerSource);
    });
  }

  private async processTriggerLocked(
    sessionId: string,
    triggerId: string,
    ownerSource: "text" | "voice"
  ): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session || session.state !== "active") return;
    const spokenRequested =
      session.speak_mode === "on" ||
      (session.speak_mode === "mirror" && ownerSource === "voice");
    const spoken = spokenRequested && Boolean(this.ffmpegPath);
    const outbound = this.db.beginOutbound(triggerId, sessionId, spoken);
    if (!outbound.claimed) return;
    try {
      let content = outbound.existing?.clean_content ?? undefined;
      let expression = outbound.existing?.expression as Expression | undefined;
      if (!content) {
        const character = this.db.getCharacterById(session.character_id);
        if (!character) {
          throw new SkyError(
            "The bound character no longer exists",
            "CHARACTER_DELETED"
          );
        }
        const files = await this.characters.read(character);
        const prompt = buildRoleplayPrompt({
          ...files,
          recent: this.db.messagesThroughTrigger(
            session.id,
            triggerId,
            MAX_RECENT_MESSAGES
          ),
          spoken
        });
        const result = await this.openCode.roleplay(
          session.model_id,
          prompt,
          session.reasoning_mode
        );
        const visible = parseExpression(result.content, spoken);
        content = visible.content;
        expression = visible.expression;
        if (!content) {
          throw new SkyError(
            "The roleplay model returned an empty response",
            "EMPTY_RESPONSE",
            true
          );
        }
        this.db.markOutboundGenerated(triggerId, content, expression);
        if (result.fellBack) {
          this.logger.warn(
            {
              threadId: session.thread_id,
              requestedModel: session.model_id,
              actualModel: result.actualModel
            },
            "Roleplay model used automatic Hy3 fallback"
          );
        }
      }
      const responseId = await this.deliver(
        session,
        triggerId,
        content,
        expression,
        spokenRequested
      );
      const assistant = this.db.appendMessage({
        sessionId: session.id,
        discordMessageId: responseId,
        role: "assistant",
        content,
        source: spoken ? "voice" : "text",
        triggeringDiscordMessageId: triggerId
      });
      this.db.markOutboundSent({
        triggerId,
        responseDiscordId: responseId,
        assistantRowId: assistant.row.id
      });
    } catch (error) {
      this.db.failOutbound(triggerId, safeErrorMessage(error));
      throw error;
    }
  }

  private async deliver(
    session: SessionRow,
    triggerId: string,
    content: string,
    expression: Expression | undefined,
    spokenRequested: boolean
  ): Promise<string> {
    if (spokenRequested && this.ffmpegPath) {
      let encoded: Awaited<ReturnType<typeof encodeDiscordVoice>>;
      try {
        const character = this.db.getCharacterById(session.character_id);
        if (!character) throw new Error("Character no longer exists");
        const speech = await this.cartesia.synthesize({
          text: content,
          voice: character.voice,
          ...(expression === undefined ? {} : { expression })
        });
        encoded = await encodeDiscordVoice(
          speech.audio.pcm,
          this.ffmpegPath
        );
      } catch (error) {
        this.logger.warn(
          {
            threadId: session.thread_id,
            error: safeErrorMessage(error)
          },
          "Voice output failed; sending clean text fallback"
        );
        return await this.sender.sendText(
          session.thread_id,
          `${content}\n\n_(Voice generation failed; sent as text.)_`,
          triggerId
        );
      }
      return await this.sender.sendVoice(
        session.thread_id,
        encoded,
        triggerId
      );
    }
    const suffix = spokenRequested
      ? "\n\n_(FFmpeg is unavailable; sent as text. Run `sky doctor`.)_"
      : "";
    return await this.sender.sendText(
      session.thread_id,
      `${content}${suffix}`,
      triggerId
    );
  }
}
