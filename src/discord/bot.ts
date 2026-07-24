import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction
} from "discord.js";
import type { Logger } from "pino";
import { CharacterFiles } from "../characters.js";
import type { SkyConfig, SkySecrets } from "../config.js";
import {
  MODEL_IDS,
  MODEL_NAMES,
  SPEAK_MODES,
  VOICE_NAMES,
  type ModelId,
  type SpeakMode,
  type VoiceName
} from "../constants.js";
import type { CurationScheduler } from "../curation.js";
import { SkyDatabase, type SessionRow } from "../db.js";
import { safeErrorMessage } from "../errors.js";
import type { OpenCodeProvider } from "../providers/opencode.js";
import type { InboundVoiceAttachment, RoleplayEngine } from "../roleplay.js";
import { DiscordTransport } from "./transport.js";

export class SkyDiscordBot {
  private readonly pendingCharacterNames = new Map<string, string>();

  public constructor(
    private readonly config: SkyConfig,
    private readonly secrets: SkySecrets,
    private readonly db: SkyDatabase,
    private readonly characters: CharacterFiles,
    private readonly roleplay: RoleplayEngine,
    private readonly curation: CurationScheduler,
    private readonly openCode: Pick<OpenCodeProvider, "listModels" | "reasoningModesFromMetadata">,
    private readonly transport: DiscordTransport,
    private readonly logger: Logger
  ) {}

  public bind(): void {
    this.transport.client.on(Events.MessageCreate, (message) => {
      // Authorization is deliberately checked before even reading attachment data.
      if (
        message.author.id !== this.config.discordOwnerUserId ||
        message.guildId !== this.config.discordGuildId ||
        message.author.bot ||
        !message.channel.isThread()
      ) {
        return;
      }
      const rawAttachment = message.flags.has(MessageFlags.IsVoiceMessage)
        ? message.attachments.first()
        : undefined;
      let voice: InboundVoiceAttachment | undefined;
      if (rawAttachment) {
        const extra = rawAttachment as unknown as {
          duration?: number;
          waveform?: string;
        };
        voice = {
          id: rawAttachment.id,
          url: rawAttachment.url,
          filename: rawAttachment.name,
          contentType: rawAttachment.contentType ?? "application/octet-stream",
          size: rawAttachment.size,
          ...(extra.duration === undefined ? {} : { duration: extra.duration }),
          ...(extra.waveform === undefined ? {} : { waveform: extra.waveform })
        };
      }
      void this.roleplay.handle({
        eventId: message.id,
        authorId: message.author.id,
        guildId: message.guildId,
        threadId: message.channelId,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
        ...(voice ? { voice } : {})
      });
    });
    this.transport.client.on(Events.InteractionCreate, (interaction) => {
      if (
        interaction.user.id !== this.config.discordOwnerUserId ||
        interaction.guildId !== this.config.discordGuildId
      ) {
        return;
      }
      void this.handleInteraction(interaction);
    });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      await this.handleAutocomplete(interaction);
      return;
    }
    if (!this.db.claimEvent(interaction.id, `INTERACTION_${interaction.type}`))
      return;
    try {
      if (interaction.isChatInputCommand()) {
        await this.handleCommand(interaction);
      } else if (interaction.isModalSubmit()) {
        await this.handleModal(interaction);
      } else if (interaction.isButton()) {
        await this.handleButton(interaction);
      }
      this.db.completeEvent(interaction.id);
    } catch (error) {
      const safe = safeErrorMessage(error);
      this.db.failEvent(interaction.id, safe);
      this.logger.warn(
        { interactionId: interaction.id, error: safe },
        "Discord interaction failed"
      );
      if (interaction.isRepliable()) {
        const payload = {
          content: `Sky could not complete that command: ${safe}`,
          flags: MessageFlags.Ephemeral
        } as const;
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(payload).catch(() => undefined);
        } else {
          await interaction.reply(payload).catch(() => undefined);
        }
      }
    }
  }

  private async handleCommand(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (
      ["character", "start"].includes(interaction.commandName) &&
      interaction.channelId !== this.config.discordLobbyChannelId
    ) {
      await interaction.reply({
        content: "Use that command in the configured Sky lobby.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    switch (interaction.commandName) {
      case "character":
        await this.handleCharacterCommand(interaction);
        return;
      case "start":
        await this.handleStart(interaction);
        return;
      case "restart":
        await interaction.reply({
          content: "Restarting only the Discord Gateway connection…",
          flags: MessageFlags.Ephemeral
        });
        setTimeout(() => {
          void this.transport.restartGateway(this.secrets.discordBotToken);
        }, 250).unref();
        return;
    }

    const session = await this.requireThreadSession(interaction);
    if (!session) return;
    switch (interaction.commandName) {
      case "end":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        {
          const result = await this.curation.endSession(session.id);
          await interaction.editReply(
            result.alreadyEnded
              ? "This session is already ending or ended. Any pending curation remains queued."
              : result.queued
                ? "Session closed to new roleplay messages. Curation started; the thread will be archived and locked after it succeeds."
                : "Session ended. There was nothing new to curate; the thread is being archived."
          );
        }
        return;
      case "speak": {
        const mode = interaction.options.getString("mode", true) as SpeakMode;
        if (!(SPEAK_MODES as readonly string[]).includes(mode)) return;
        this.db.updateSessionSettings(session.id, { speakMode: mode });
        await interaction.reply({
          content: `Speech mode is now **${mode}** for this thread.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      case "voice": {
        const voice = interaction.options.getString("voice", true) as VoiceName;
        if (!(VOICE_NAMES as readonly string[]).includes(voice)) return;
        this.db.setCharacterVoice(session.character_id, voice);
        await interaction.reply({
          content: `The character voice is now **${voice}** in every active thread.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      case "model": {
        const model = interaction.options.getString("model", true) as ModelId;
        if (!(MODEL_IDS as readonly string[]).includes(model)) return;
        this.db.updateSessionSettings(session.id, { modelId: model });
        await interaction.reply({
          content: `Roleplay model is now **${MODEL_NAMES[model]}**. Reasoning reset to the verified default.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      case "reasoning":
        await this.handleReasoning(interaction, session);
        return;
      default:
        await interaction.reply({
          content: "Unknown Sky command.",
          flags: MessageFlags.Ephemeral
        });
    }
  }

  private async handleCharacterCommand(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "list") {
      const characters = this.db.listCharacters();
      await interaction.reply({
        content: characters.length
          ? characters
              .map((character) => `• **${character.name}** — ${character.voice}`)
              .join("\n")
          : "No characters exist yet.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const name = interaction.options.getString("name", true).trim();
    if (subcommand === "create") {
      const key = interaction.id;
      this.pendingCharacterNames.set(key, name);
      const modal = new ModalBuilder()
        .setCustomId(`character-create:${key}`)
        .setTitle(`Create ${name}`.slice(0, 45));
      const field = (
        id: string,
        label: string,
        placeholder: string,
        required = true
      ) =>
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(id)
            .setLabel(label)
            .setPlaceholder(placeholder)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(required)
            .setMaxLength(2_000)
        );
      modal.addComponents(
        field("identity", "Identity (fictional adult)", "Age 18+, role, history"),
        field("personality", "Personality", "Voice, manner, desires, flaws"),
        field("appearance", "Appearance", "Adult physical description"),
        field(
          "setting",
          "Setting and boundaries",
          "World, relationship, hard boundaries"
        ),
        field(
          "memory",
          "Initial persistent memory (optional)",
          "Durable facts only",
          false
        )
      );
      await interaction.showModal(modal);
      return;
    }
    if (subcommand === "delete") {
      const character = this.db.getCharacterByName(name);
      if (!character) {
        await interaction.reply({
          content: `No character named **${name}** exists.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`character-delete:${character.id}`)
          .setLabel(`Permanently delete ${character.name}`.slice(0, 80))
          .setStyle(ButtonStyle.Danger)
      );
      await interaction.reply({
        content:
          "This permanently removes the character's editable SOUL.md and MEMORY.md files. Confirm explicitly:",
        components: [row],
        flags: MessageFlags.Ephemeral
      });
    }
  }

  private async handleModal(
    interaction: ModalSubmitInteraction
  ): Promise<void> {
    if (!interaction.customId.startsWith("character-create:")) return;
    const key = interaction.customId.slice("character-create:".length);
    const name = this.pendingCharacterNames.get(key);
    this.pendingCharacterNames.delete(key);
    if (!name) {
      await interaction.reply({
        content: "That creation form expired. Run `/character create` again.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const character = await this.characters.create({
      name,
      identity: interaction.fields.getTextInputValue("identity"),
      personality: interaction.fields.getTextInputValue("personality"),
      appearance: interaction.fields.getTextInputValue("appearance"),
      settingAndBoundaries: interaction.fields.getTextInputValue("setting"),
      memorySeed: interaction.fields.getTextInputValue("memory"),
      voice: this.config.defaultVoice
    });
    await interaction.reply({
      content: `Created **${character.name}** with editable SOUL.md and MEMORY.md files.`,
      flags: MessageFlags.Ephemeral
    });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.customId.startsWith("character-delete:")) return;
    const id = interaction.customId.slice("character-delete:".length);
    const character = this.db.getCharacterById(id);
    if (!character) {
      await interaction.reply({
        content: "That character is already deleted.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (this.db.activeSessionCountForCharacter(character.id) > 0) {
      await interaction.reply({
        content:
          "End every active session for this character before permanently deleting it.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await this.characters.deleteFiles(character);
    await interaction.update({
      content: `Permanently deleted **${character.name}** and its character files.`,
      components: []
    });
  }

  private async handleStart(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const name = interaction.options.getString("character", true);
    const character = this.db.getCharacterByName(name);
    if (!character) {
      await interaction.reply({
        content: `No character named **${name}** exists.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const thread = await this.transport.createSessionThread(character.name);
    this.db.createSession({
      characterId: character.id,
      threadId: thread.id,
      guildId: this.config.discordGuildId,
      lobbyChannelId: this.config.discordLobbyChannelId
    });
    await thread.send({
      content: `You are now speaking with **${character.name}**. Talk normally; no mention is needed. Use \`/end\` when you want to close and curate the session.`,
      allowedMentions: { parse: [] }
    });
    await interaction.editReply(`Started <#${thread.id}>.`);
  }

  private async handleReasoning(
    interaction: ChatInputCommandInteraction,
    session: SessionRow
  ): Promise<void> {
    const capabilities = await this.reasoningCapabilities(session.model_id);
    const requested = interaction.options.getString("mode");
    if (requested) {
      if (!capabilities.modes.includes(requested)) {
        await interaction.reply({
          content: `That mode is not verified for **${MODEL_NAMES[session.model_id]}**. Available: ${capabilities.modes.join(", ")}.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      this.db.updateSessionSettings(session.id, { reasoningMode: requested });
      await interaction.reply({
        content: `Reasoning mode is now **${requested}** for this thread.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const explanation =
      capabilities.modes.length === 1
        ? "The provider currently exposes no selectable reasoning modes, so only the model default is available."
        : `Verified modes: ${capabilities.modes.join(", ")}.`;
    await interaction.reply({
      content: `Current: **${session.reasoning_mode}** for **${MODEL_NAMES[session.model_id]}**.\n${explanation}`,
      flags: MessageFlags.Ephemeral
    });
  }

  private async handleAutocomplete(
    interaction: AutocompleteInteraction
  ): Promise<void> {
    if (
      interaction.commandName === "character" ||
      interaction.commandName === "start"
    ) {
      const focused = interaction.options.getFocused().toLocaleLowerCase();
      await interaction.respond(
        this.db
          .listCharacters()
          .filter((character) =>
            character.name.toLocaleLowerCase().includes(focused)
          )
          .slice(0, 25)
          .map((character) => ({
            name: character.name,
            value: character.name
          }))
      );
      return;
    }
    if (interaction.commandName === "reasoning") {
      const session = this.db.getSessionByThread(interaction.channelId);
      if (!session) {
        await interaction.respond([]);
        return;
      }
      const capabilities = await this.reasoningCapabilities(session.model_id);
      const focused = interaction.options.getFocused().toLocaleLowerCase();
      await interaction.respond(
        capabilities.modes
          .filter((mode) => mode.toLocaleLowerCase().includes(focused))
          .slice(0, 25)
          .map((mode) => ({ name: mode, value: mode }))
      );
    }
  }

  private async reasoningCapabilities(
    modelId: ModelId
  ): Promise<{ modes: string[]; source: string; checkedAt: string }> {
    const cached = this.db.getModelCapabilities(modelId);
    if (
      cached &&
      Date.now() - new Date(cached.checkedAt).getTime() < 24 * 60 * 60 * 1000
    ) {
      return cached;
    }
    const metadata = await this.openCode.listModels();
    for (const candidate of MODEL_IDS) {
      const capability = this.openCode.reasoningModesFromMetadata(
        candidate,
        metadata
      );
      this.db.saveModelCapabilities(
        candidate,
        capability.modes,
        capability.source
      );
    }
    return this.db.getModelCapabilities(modelId)!;
  }

  private async requireThreadSession(
    interaction: ChatInputCommandInteraction
  ): Promise<SessionRow | undefined> {
    const session = this.db.getSessionByThread(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "Use that command inside a Sky character thread.",
        flags: MessageFlags.Ephemeral
      });
      return undefined;
    }
    return session;
  }
}
