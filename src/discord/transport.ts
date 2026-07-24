import {
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type ThreadChannel
} from "discord.js";
import type { APIMessage } from "discord-api-types/v10";
import type { Logger } from "pino";
import type { EncodedVoice } from "../audio.js";
import type { SkyConfig } from "../config.js";
import type { SkySecrets } from "../config.js";
import { GUILD_COMMANDS } from "./commands.js";

export class DiscordTransport {
  public readonly client: Client;
  public readonly rest: REST;
  private stopping = false;

  public constructor(
    private readonly config: SkyConfig,
    secrets: SkySecrets,
    private readonly logger: Logger
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ],
      allowedMentions: { parse: [], repliedUser: false }
    });
    this.rest = new REST({ version: "10", timeout: 30_000 }).setToken(
      secrets.discordBotToken
    );
    this.client.on("error", (error) => {
      this.logger.error({ error: error.message }, "Discord client error");
    });
    this.client.on("shardError", (error) => {
      this.logger.error({ error: error.message }, "Discord shard error");
    });
    this.client.on("shardDisconnect", (event, shardId) => {
      this.logger.warn(
        { code: event.code, shardId },
        "Discord Gateway disconnected"
      );
    });
    this.client.on("shardResume", (shardId, replayedEvents) => {
      this.logger.info(
        { shardId, replayedEvents },
        "Discord Gateway resumed"
      );
    });
  }

  public async start(token: string): Promise<void> {
    this.stopping = false;
    await this.client.login(token);
    if (!this.client.isReady()) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Discord Gateway ready timeout")),
          30_000
        );
        this.client.once("ready", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    await this.client.destroy();
  }

  public async restartGateway(token: string): Promise<void> {
    this.logger.info("Restarting Discord Gateway connection");
    await this.client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!this.stopping) await this.start(token);
  }

  public gatewayStatus(): {
    connected: boolean;
    ping: number;
    user?: string;
  } {
    return {
      connected: this.client.isReady(),
      ping: this.client.ws.ping,
      ...(this.client.user ? { user: this.client.user.tag } : {})
    };
  }

  public async registerGuildCommands(): Promise<number> {
    const commands = (await this.rest.put(
      Routes.applicationGuildCommands(
        this.config.discordApplicationId,
        this.config.discordGuildId
      ),
      { body: GUILD_COMMANDS }
    )) as unknown[];
    return commands.length;
  }

  public async createSessionThread(
    characterName: string
  ): Promise<ThreadChannel> {
    const channel = await this.client.channels.fetch(
      this.config.discordLobbyChannelId
    );
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const name = `${characterName} — ${stamp}`.slice(0, 100);
    let thread: ThreadChannel;
    if (channel?.type === ChannelType.GuildText) {
      thread = await channel.threads.create({
        name,
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        reason: `Sky session for ${characterName}`
      });
      await thread.members.add(this.config.discordOwnerUserId);
    } else if (channel?.type === ChannelType.GuildForum) {
      thread = await channel.threads.create({
        name,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        message: {
          content: `Session started with **${characterName}**.`,
          allowedMentions: { parse: [] }
        },
        reason: `Sky session for ${characterName}`
      });
    } else {
      throw new Error(
        "The configured lobby must be a Discord text or forum channel"
      );
    }
    return thread;
  }

  public async sendText(
    channelId: string,
    content: string,
    nonce: string
  ): Promise<string> {
    const chunks = splitDiscordMessage(content);
    let firstId: string | undefined;
    for (const [index, chunk] of chunks.entries()) {
      const message = (await this.rest.post(Routes.channelMessages(channelId), {
        body: {
          content: chunk,
          allowed_mentions: { parse: [] },
          nonce: `${nonce}-${index}`.slice(0, 25),
          enforce_nonce: true
        }
      })) as APIMessage;
      firstId ??= message.id;
    }
    return firstId!;
  }

  public async sendVoice(
    channelId: string,
    voice: EncodedVoice,
    nonce: string
  ): Promise<string> {
    const message = (await this.rest.post(Routes.channelMessages(channelId), {
      body: {
        flags: MessageFlags.IsVoiceMessage,
        nonce: `${nonce}-v`.slice(0, 25),
        enforce_nonce: true,
        attachments: [
          {
            id: "0",
            filename: "voice-message.ogg",
            duration_secs: voice.durationSeconds,
            waveform: voice.waveform
          }
        ]
      },
      files: [
        {
          data: voice.ogg,
          name: "voice-message.ogg",
          contentType: "audio/ogg"
        }
      ]
    })) as APIMessage;
    return message.id;
  }

  public async archiveAndLockThread(threadId: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel?.isThread()) {
      throw new Error("Discord thread no longer exists");
    }
    if (channel.archived && channel.locked) return;
    await channel.setArchived(true, "Sky session ended and curated");
    await channel.setLocked(true, "Sky session ended and curated");
  }

  public async verifyGuild(): Promise<{
    guild: boolean;
    owner: boolean;
    lobby: boolean;
    lobbyNsfw: boolean;
    permissions: string[];
  }> {
    const guild = await this.client.guilds.fetch(this.config.discordGuildId);
    const member = await guild.members.fetch(this.config.discordOwnerUserId);
    const lobby = await guild.channels.fetch(this.config.discordLobbyChannelId);
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const permissions = lobby?.permissionsFor(me);
    return {
      guild: Boolean(guild),
      owner: Boolean(member),
      lobby: Boolean(lobby),
      lobbyNsfw:
        Boolean(lobby && "nsfw" in lobby && (lobby as { nsfw?: boolean }).nsfw),
      permissions: permissions?.toArray() ?? []
    };
  }
}

function splitDiscordMessage(content: string): string[] {
  const chunks: string[] = [];
  let remaining = content.trim();
  while (remaining.length > 2_000) {
    let boundary = remaining.lastIndexOf("\n", 1_950);
    if (boundary < 1_000) boundary = remaining.lastIndexOf(" ", 1_950);
    if (boundary < 1_000) boundary = 1_950;
    chunks.push(remaining.slice(0, boundary).trimEnd());
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ["…"];
}
