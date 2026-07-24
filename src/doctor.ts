import { randomUUID } from "node:crypto";
import {
  access,
  constants as fsConstants,
  mkdir,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { Routes } from "discord.js";
import { detectFfmpeg, encodeDiscordVoice } from "./audio.js";
import {
  configPath,
  loadConfig,
  skyHome,
  type SkyConfig,
  type SkySecrets
} from "./config.js";
import { MODEL_IDS } from "./constants.js";
import { SkyDatabase } from "./db.js";
import { GUILD_COMMANDS } from "./discord/commands.js";
import {
  DiscordTransport,
  requiredLobbyPermissions
} from "./discord/transport.js";
import { safeErrorMessage } from "./errors.js";
import { createLogger } from "./logger.js";
import { CartesiaTts } from "./providers/cartesia.js";
import { GroqTranscriber } from "./providers/groq.js";
import { OpenCodeProvider } from "./providers/opencode.js";
import { DpapiSecretStore } from "./secrets.js";
import { runProcess } from "./windows/process.js";
import { WindowsServiceManager } from "./windows/service-manager.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

function push(
  checks: DoctorCheck[],
  name: string,
  ok: boolean,
  detail: string,
  warning = false
): void {
  checks.push({
    name,
    status: ok ? "pass" : warning ? "warn" : "fail",
    detail
  });
}

export async function runDoctor(options: {
  home?: string;
  online?: boolean;
} = {}): Promise<DoctorReport> {
  const home = options.home ?? skyHome();
  const online = options.online ?? true;
  const checks: DoctorCheck[] = [];
  let config: SkyConfig;
  let secrets: SkySecrets;
  try {
    config = await loadConfig(home);
    push(checks, "Configuration", true, `Valid: ${configPath(home)}`);
  } catch (error) {
    push(
      checks,
      "Configuration",
      false,
      `${safeErrorMessage(error)}. Run \`sky setup\`.`
    );
    return { checks, ok: false };
  }
  try {
    secrets = await new DpapiSecretStore(home).load();
    push(checks, "Protected secrets", true, "DPAPI decryption succeeded");
    const acl = await runProcess("icacls.exe", [
      path.join(home, "secrets.dpapi")
    ]);
    const broad = /\bEveryone:|\bUsers:/i.test(acl.stdout);
    push(
      checks,
      "Secret file ACL",
      acl.code === 0 && !broad,
      broad
        ? "Secret ACL is broad; rerun `sky setup` from an elevated terminal"
        : "Restricted ACL readable by owner, SYSTEM and Administrators"
    );
  } catch (error) {
    push(checks, "Protected secrets", false, safeErrorMessage(error));
    return { checks, ok: false };
  }

  try {
    await mkdir(config.dataDir, { recursive: true });
    const probe = path.join(config.dataDir, `.doctor-${randomUUID()}.tmp`);
    await writeFile(probe, "sky", { flag: "wx" });
    await access(probe, fsConstants.R_OK | fsConstants.W_OK);
    await unlink(probe);
    push(
      checks,
      "Data location",
      true,
      `Readable and writable: ${config.dataDir}`
    );
  } catch (error) {
    push(checks, "Data location", false, safeErrorMessage(error));
  }

  let db: SkyDatabase | undefined;
  try {
    db = new SkyDatabase(path.join(config.dataDir, "sky.sqlite"));
    const health = db.health();
    push(checks, "SQLite", health.ok, health.detail);
    const migration = db.raw
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    push(
      checks,
      "Database migrations",
      migration.version >= 1,
      `Schema version ${migration.version}`
    );
    let characterFilesOk = true;
    for (const character of db.listCharacters()) {
      try {
        await access(
          character.soul_path,
          fsConstants.R_OK | fsConstants.W_OK
        );
        await access(
          character.memory_path,
          fsConstants.R_OK | fsConstants.W_OK
        );
      } catch {
        characterFilesOk = false;
      }
    }
    push(
      checks,
      "Character files",
      characterFilesOk,
      characterFilesOk
        ? `${db.listCharacters().length} character(s), files accessible`
        : "One or more SOUL.md/MEMORY.md files are inaccessible"
    );
  } catch (error) {
    push(checks, "SQLite", false, safeErrorMessage(error));
  }

  const service = new WindowsServiceManager(home);
  const serviceStatus = await service.status();
  push(
    checks,
    "Windows service",
    serviceStatus !== "not-installed",
    serviceStatus === "not-installed"
      ? "Not registered; run `sky setup` as Administrator"
      : `Registered; state is ${serviceStatus}`
  );

  const ffmpeg = await detectFfmpeg();
  push(checks, "FFmpeg", ffmpeg.ok, ffmpeg.detail);
  if (ffmpeg.ok && ffmpeg.path) {
    try {
      const pcm = Buffer.alloc(48_000 * 2 / 5);
      const encoded = await encodeDiscordVoice(pcm, ffmpeg.path);
      push(
        checks,
        "Audio encoding",
        encoded.ogg.subarray(0, 4).toString("ascii") === "OggS" &&
          encoded.durationSeconds > 0 &&
          Boolean(encoded.waveform),
        "48 kHz mono PCM encoded to Discord-compatible OGG Opus with duration and waveform"
      );
    } catch (error) {
      push(checks, "Audio encoding", false, safeErrorMessage(error));
    }
  } else {
    push(
      checks,
      "Audio encoding",
      false,
      "Cannot verify until FFmpeg is installed"
    );
  }

  if (!online) {
    push(
      checks,
      "Online checks",
      false,
      "Skipped by --offline",
      true
    );
    db?.close();
    return {
      checks,
      ok: !checks.some((check) => check.status === "fail")
    };
  }

  const openCode = new OpenCodeProvider(secrets.openCodeApiKey);
  try {
    const models = await openCode.availableRequiredModels();
    push(
      checks,
      "OpenCode Go",
      models.missing.length === 0,
      models.missing.length
        ? `Missing required models: ${models.missing.join(", ")}`
        : `Required models available: ${models.available.join(", ")}`
    );
    for (const model of MODEL_IDS) {
      const capability = openCode.reasoningModesFromMetadata(
        model,
        models.metadata
      );
      push(
        checks,
        `Reasoning: ${model}`,
        capability.modes.length >= 1,
        `${capability.modes.join(", ")} — ${capability.source}`
      );
    }
  } catch (error) {
    push(checks, "OpenCode Go", false, safeErrorMessage(error));
  }

  const groq = new GroqTranscriber(secrets.groqApiKey);
  try {
    push(
      checks,
      "Groq",
      await groq.ready(),
      "whisper-large-v3-turbo is available"
    );
  } catch (error) {
    push(checks, "Groq", false, safeErrorMessage(error));
  }

  const cartesia = new CartesiaTts(
    secrets.cartesiaPrimaryApiKey,
    secrets.cartesiaBackupApiKey
  );
  try {
    await cartesia.checkKey("primary");
    push(checks, "Cartesia primary", true, "Key accepted");
  } catch (error) {
    push(checks, "Cartesia primary", false, safeErrorMessage(error));
  }
  if (secrets.cartesiaBackupApiKey) {
    try {
      await cartesia.checkKey("backup");
      push(checks, "Cartesia backup", true, "Key accepted");
    } catch (error) {
      push(checks, "Cartesia backup", false, safeErrorMessage(error));
    }
  } else {
    push(
      checks,
      "Cartesia backup",
      false,
      "Optional backup key is not configured",
      true
    );
  }

  const logger = createLogger(config);
  const discord = new DiscordTransport(config, secrets, logger);
  try {
    const me = (await discord.rest.get(Routes.user())) as { id?: string };
    push(
      checks,
      "Discord bot token",
      Boolean(me.id),
      `Authenticated bot user ${me.id ?? "unknown"}`
    );
    await discord.rest.get(Routes.guild(config.discordGuildId));
    await discord.rest.get(
      Routes.guildMember(config.discordGuildId, config.discordOwnerUserId)
    );
    const lobby = (await discord.rest.get(
      Routes.channel(config.discordLobbyChannelId)
    )) as { id?: string; nsfw?: boolean; type?: number };
    push(
      checks,
      "Discord guild/owner/lobby",
      lobby.id === config.discordLobbyChannelId,
      `Guild, owner and lobby resolved${lobby.nsfw ? "; lobby is age-restricted" : "; lobby is not age-restricted"}`
    );
    push(
      checks,
      "Adult-channel safety",
      lobby.nsfw === true,
      lobby.nsfw
        ? "Lobby is marked age-restricted"
        : "Mark the lobby age-restricted in Discord before adult roleplay",
      true
    );
    const commands = (await discord.rest.get(
      Routes.applicationGuildCommands(
        config.discordApplicationId,
        config.discordGuildId
      )
    )) as Array<{ name: string }>;
    const expected = new Set(GUILD_COMMANDS.map((command) => command.name));
    const registered = new Set(commands.map((command) => command.name));
    const commandsOk =
      expected.size === registered.size &&
      [...expected].every((name) => registered.has(name));
    push(
      checks,
      "Slash commands",
      commandsOk,
      commandsOk
        ? `${commands.length} guild commands registered`
        : "Guild commands differ; rerun `sky setup`"
    );
    await discord.start(secrets.discordBotToken);
    const guildState = await discord.verifyGuild();
    const requiredPermissions = requiredLobbyPermissions(
      guildState.lobbyType
    );
    const missing = requiredPermissions.filter(
      (permission) => !guildState.permissions.includes(permission as never)
    );
    push(
      checks,
      "Discord permissions",
      missing.length === 0,
      missing.length
        ? `Missing in lobby: ${missing.join(", ")}`
        : "Required lobby/thread permissions are present"
    );
    if (serviceStatus === "running") {
      const runtime = db?.getServiceState<{
        gateway?: { connected?: boolean; ping?: number };
        heartbeatAt?: string;
      }>("runtime");
      const fresh =
        runtime?.heartbeatAt &&
        Date.now() - new Date(runtime.heartbeatAt).getTime() < 30_000;
      push(
        checks,
        "Discord Gateway",
        Boolean(fresh && runtime?.gateway?.connected),
        fresh && runtime?.gateway?.connected
          ? `Connected by service; ${runtime.gateway.ping ?? -1} ms`
          : "Service Gateway heartbeat is absent or stale"
      );
    } else {
      push(
        checks,
        "Discord Gateway",
        discord.gatewayStatus().connected,
        discord.gatewayStatus().connected
          ? "Gateway connection succeeded"
          : "Gateway did not become ready"
      );
    }
    await discord.stop();
  } catch (error) {
    push(checks, "Discord connectivity", false, safeErrorMessage(error));
    await discord.stop().catch(() => undefined);
  }

  db?.close();
  logger.flush();
  return {
    checks,
    ok: !checks.some((check) => check.status === "fail")
  };
}

export function printDoctorReport(report: DoctorReport): void {
  for (const check of report.checks) {
    const icon =
      check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    console.log(`[${icon}] ${check.name}: ${check.detail}`);
  }
}
