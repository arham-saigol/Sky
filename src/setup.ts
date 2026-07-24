import {
  confirm,
  input,
  password,
  select
} from "@inquirer/prompts";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { detectFfmpeg } from "./audio.js";
import {
  ConfigSchema,
  defaultDataDir,
  loadConfig,
  saveConfig,
  type SkyConfig,
  type SkySecrets
} from "./config.js";
import { MODEL_IDS, VOICE_NAMES, type VoiceName } from "./constants.js";
import { GUILD_COMMANDS } from "./discord/commands.js";
import { DiscordTransport } from "./discord/transport.js";
import { SkyError } from "./errors.js";
import { createLogger } from "./logger.js";
import { CartesiaTts } from "./providers/cartesia.js";
import { GroqTranscriber } from "./providers/groq.js";
import { OpenCodeProvider } from "./providers/opencode.js";
import { DpapiSecretStore } from "./secrets.js";
import { runProcess } from "./windows/process.js";
import { WindowsServiceManager } from "./windows/service-manager.js";

function snowflake(value: string): true | string {
  return /^\d{15,22}$/.test(value.trim())
    ? true
    : "Enter a Discord numeric ID (15–22 digits)";
}

function required(value: string): true | string {
  return value.trim() ? true : "This value is required";
}

async function oldState(home?: string): Promise<{
  config?: SkyConfig;
  secrets?: SkySecrets;
}> {
  try {
    const config = await loadConfig(home);
    try {
      const secrets = await new DpapiSecretStore(home).load();
      return { config, secrets };
    } catch {
      return { config };
    }
  } catch {
    return {};
  }
}

async function secretPrompt(
  message: string,
  existing: string | undefined,
  optional = false
): Promise<string | undefined> {
  const answer = await password({
    message: existing ? `${message} (leave blank to keep current)` : message,
    mask: "•",
    validate: (value) =>
      value || existing || optional ? true : "This key is required"
  });
  return answer || existing;
}

export async function runSetup(home: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new SkyError(
      "Sky setup must run on Windows because secrets are protected with DPAPI",
      "WINDOWS_REQUIRED"
    );
  }
  const old = await oldState(home);
  console.log(
    old.config
      ? "Reconfiguring Sky. Existing protected keys can be kept by leaving them blank."
      : "Configuring Sky for this Windows computer."
  );
  const consent = await confirm({
    message:
      "I consent to adult fictional roleplay and will use only fictional adult characters and participants",
    default: false
  });
  if (!consent) {
    throw new SkyError(
      "Sky access requires explicit consent and the fictional-adults restriction",
      "CONSENT_REQUIRED"
    );
  }
  const openCodeApiKey = await secretPrompt(
    "OpenCode Go API key",
    old.secrets?.openCodeApiKey
  );
  const discordBotToken = await secretPrompt(
    "Discord bot token",
    old.secrets?.discordBotToken
  );
  const discordApplicationId = await input({
    message: "Discord application ID",
    default: old.config?.discordApplicationId,
    validate: snowflake
  });
  const discordPublicKey = await input({
    message: "Discord public key",
    default: old.config?.discordPublicKey,
    validate: (value) =>
      /^[a-fA-F0-9]{64}$/.test(value.trim())
        ? true
        : "Enter the 64-character hexadecimal Discord public key"
  });
  const discordGuildId = await input({
    message: "Private Discord guild (server) ID",
    default: old.config?.discordGuildId,
    validate: snowflake
  });
  const discordOwnerUserId = await input({
    message: "Discord owner user ID",
    default: old.config?.discordOwnerUserId,
    validate: snowflake
  });
  const discordLobbyChannelId = await input({
    message: "Discord lobby channel ID",
    default: old.config?.discordLobbyChannelId,
    validate: snowflake
  });
  const groqApiKey = await secretPrompt(
    "Groq API key",
    old.secrets?.groqApiKey
  );
  const cartesiaPrimaryApiKey = await secretPrompt(
    "Primary Cartesia API key",
    old.secrets?.cartesiaPrimaryApiKey
  );
  const cartesiaBackupApiKey = await secretPrompt(
    "Backup Cartesia API key (optional)",
    old.secrets?.cartesiaBackupApiKey,
    true
  );
  const defaultVoice = await select<VoiceName>({
    message: "Default Cartesia voice",
    choices: VOICE_NAMES.map((voice) => ({ name: voice, value: voice })),
    default: old.config?.defaultVoice ?? "Katie"
  });
  const dataDir = path.resolve(
    await input({
      message: "Data location",
      default: old.config?.dataDir ?? defaultDataDir(home),
      validate: required
    })
  );
  const logLevel = await select<"debug" | "info" | "warn" | "error">({
    message: "Log level",
    choices: ["debug", "info", "warn", "error"].map((value) => ({
      name: value,
      value: value as "debug" | "info" | "warn" | "error"
    })),
    default: old.config?.logLevel ?? "info"
  });
  const automaticStart = await confirm({
    message: "Start Sky automatically with Windows",
    default: old.config?.automaticStart ?? true
  });

  const timestamp = new Date().toISOString();
  const config = ConfigSchema.parse({
    version: 1,
    discordApplicationId: discordApplicationId.trim(),
    discordPublicKey: discordPublicKey.trim(),
    discordGuildId: discordGuildId.trim(),
    discordOwnerUserId: discordOwnerUserId.trim(),
    discordLobbyChannelId: discordLobbyChannelId.trim(),
    defaultVoice,
    dataDir,
    logLevel,
    automaticStart,
    adultConsentAt: old.config?.adultConsentAt ?? timestamp,
    configuredAt: timestamp
  });
  const secrets: SkySecrets = {
    openCodeApiKey: openCodeApiKey!,
    discordBotToken: discordBotToken!,
    groqApiKey: groqApiKey!,
    cartesiaPrimaryApiKey: cartesiaPrimaryApiKey!,
    ...(cartesiaBackupApiKey
      ? { cartesiaBackupApiKey }
      : {})
  };
  await mkdir(dataDir, { recursive: true });

  let ffmpeg = await detectFfmpeg();
  if (!ffmpeg.ok) {
    console.log(ffmpeg.detail);
    const install = await confirm({
      message: "Install FFmpeg now with winget",
      default: true
    });
    if (install) {
      const result = await runProcess(
        "winget.exe",
        [
          "install",
          "--id",
          "Gyan.FFmpeg",
          "--exact",
          "--accept-package-agreements",
          "--accept-source-agreements"
        ],
        { inherit: true }
      );
      ffmpeg = await detectFfmpeg();
      if (result.code !== 0 || !ffmpeg.ok) {
        console.warn(
          "FFmpeg installation was not verified. Setup will continue, but voice output will fall back to text until `sky doctor` passes."
        );
      }
    }
  }

  console.log("Verifying providers and Discord configuration…");
  const openCode = new OpenCodeProvider(secrets.openCodeApiKey);
  const models = await openCode.availableRequiredModels();
  if (models.missing.length) {
    throw new SkyError(
      `OpenCode Go is missing required model IDs: ${models.missing.join(", ")}`,
      "MODEL_UNAVAILABLE"
    );
  }
  const groq = new GroqTranscriber(secrets.groqApiKey);
  if (!(await groq.ready())) {
    throw new SkyError(
      "Groq does not expose whisper-large-v3-turbo for this key",
      "GROQ_UNAVAILABLE"
    );
  }
  const cartesia = new CartesiaTts(
    secrets.cartesiaPrimaryApiKey,
    secrets.cartesiaBackupApiKey
  );
  await cartesia.checkKey("primary");
  if (secrets.cartesiaBackupApiKey) await cartesia.checkKey("backup");

  const logger = createLogger(config);
  const discord = new DiscordTransport(config, secrets, logger);
  await discord.start(secrets.discordBotToken);
  try {
    const guild = await discord.verifyGuild();
    if (!guild.guild || !guild.owner || !guild.lobby) {
      throw new SkyError(
        "Discord guild, owner, or lobby could not be resolved",
        "DISCORD_CONFIGURATION"
      );
    }
    const commandCount = await discord.registerGuildCommands();
    if (commandCount !== GUILD_COMMANDS.length) {
      throw new SkyError(
        `Expected ${GUILD_COMMANDS.length} guild commands after registration, received ${commandCount}`,
        "DISCORD_COMMANDS"
      );
    }
  } finally {
    await discord.stop();
  }

  await saveConfig(config, home);
  await new DpapiSecretStore(home).save(secrets);
  for (const modelId of MODEL_IDS) {
    const capability = openCode.reasoningModesFromMetadata(
      modelId,
      models.metadata
    );
    console.log(
      `${modelId}: reasoning ${capability.modes.join(", ")} (${capability.source})`
    );
  }

  const service = new WindowsServiceManager(home);
  const previousServiceStatus = await service.status();
  if (previousServiceStatus === "running") await service.stop();
  await service.install(config);
  if (previousServiceStatus === "running") await service.start();
  console.log(
    `Sky setup complete. ${automaticStart ? "Automatic-start" : "Manual-start"} Windows service registered and ${GUILD_COMMANDS.length} guild commands refreshed.`
  );
}
