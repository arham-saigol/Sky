#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { detectFfmpeg } from "./audio.js";
import { CharacterFiles } from "./characters.js";
import { loadConfig, skyHome } from "./config.js";
import { CurationScheduler } from "./curation.js";
import { SkyDatabase } from "./db.js";
import { SkyDiscordBot } from "./discord/bot.js";
import { DiscordTransport } from "./discord/transport.js";
import { safeErrorMessage } from "./errors.js";
import { createLogger } from "./logger.js";
import { CartesiaTts } from "./providers/cartesia.js";
import { GroqTranscriber } from "./providers/groq.js";
import { OpenCodeProvider } from "./providers/opencode.js";
import { RoleplayEngine } from "./roleplay.js";
import { DpapiSecretStore } from "./secrets.js";
import { KeyedMutex } from "./util/mutex.js";

async function main(): Promise<void> {
  const home = skyHome();
  const config = await loadConfig(home);
  const secrets = await new DpapiSecretStore(home).load();
  await mkdir(config.dataDir, { recursive: true });
  const logger = createLogger(config);
  const db = new SkyDatabase(path.join(config.dataDir, "sky.sqlite"));
  const characters = new CharacterFiles(
    db,
    path.join(config.dataDir, "characters")
  );
  await characters.initialize();
  const ffmpeg = await detectFfmpeg();
  const openCode = new OpenCodeProvider(secrets.openCodeApiKey);
  const groq = new GroqTranscriber(secrets.groqApiKey);
  const cartesia = new CartesiaTts(
    secrets.cartesiaPrimaryApiKey,
    secrets.cartesiaBackupApiKey
  );
  const transport = new DiscordTransport(config, secrets, logger);
  const sessionMutex = new KeyedMutex();
  const roleplay = new RoleplayEngine(
    config.discordOwnerUserId,
    config.discordGuildId,
    config.dataDir,
    db,
    characters,
    openCode,
    groq,
    cartesia,
    transport,
    logger,
    ffmpeg.path,
    sessionMutex
  );
  const curation = new CurationScheduler(
    db,
    characters,
    openCode,
    transport,
    logger,
    15_000,
    sessionMutex
  );
  const bot = new SkyDiscordBot(
    config,
    secrets,
    db,
    characters,
    roleplay,
    curation,
    openCode,
    transport,
    logger
  );
  bot.bind();

  let stopping = false;
  const timers: {
    heartbeat: NodeJS.Timeout | undefined;
    health: NodeJS.Timeout | undefined;
  } = { heartbeat: undefined, health: undefined };
  const startedAt = new Date().toISOString();

  const health = async (): Promise<void> => {
    const gateway = transport.gatewayStatus();
    db.recordHealth(
      "discord_gateway",
      gateway.connected,
      gateway.connected
        ? `Connected as ${gateway.user ?? "bot"}; ${gateway.ping} ms`
        : "Disconnected"
    );
    const sqlite = db.health();
    db.recordHealth("sqlite", sqlite.ok, sqlite.detail);
    db.recordHealth("ffmpeg", ffmpeg.ok, ffmpeg.detail);
    try {
      const models = await openCode.availableRequiredModels();
      db.recordHealth(
        "opencode",
        models.missing.length === 0,
        models.missing.length
          ? `Missing: ${models.missing.join(", ")}`
          : `Available: ${models.available.join(", ")}`
      );
    } catch (error) {
      db.recordHealth("opencode", false, safeErrorMessage(error));
    }
    try {
      db.recordHealth(
        "groq",
        await groq.ready(),
        "whisper-large-v3-turbo available"
      );
    } catch (error) {
      db.recordHealth("groq", false, safeErrorMessage(error));
    }
    try {
      await cartesia.checkKey("primary");
      db.recordHealth("cartesia_primary", true, "Primary key accepted");
    } catch (error) {
      db.recordHealth("cartesia_primary", false, safeErrorMessage(error));
    }
    if (secrets.cartesiaBackupApiKey) {
      try {
        await cartesia.checkKey("backup");
        db.recordHealth("cartesia_backup", true, "Backup key accepted");
      } catch (error) {
        db.recordHealth("cartesia_backup", false, safeErrorMessage(error));
      }
    } else {
      db.recordHealth(
        "cartesia_backup",
        true,
        "Optional backup key not configured"
      );
    }
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Sky service stopping gracefully");
    if (timers.heartbeat) clearInterval(timers.heartbeat);
    if (timers.health) clearInterval(timers.health);
    db.setServiceState("runtime", {
      state: "stopping",
      pid: process.pid,
      startedAt,
      signal
    });
    await transport.stop();
    await Promise.all([roleplay.stop(), curation.stop()]);
    db.setServiceState("runtime", {
      state: "stopped",
      pid: process.pid,
      startedAt,
      stoppedAt: new Date().toISOString()
    });
    db.close();
    logger.flush();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").then(() => process.exit(0));
  });
  process.once("SIGHUP", () => {
    void shutdown("SIGHUP").then(() => process.exit(0));
  });
  process.on("uncaughtException", (error) => {
    logger.fatal({ error: safeErrorMessage(error) }, "Uncaught service error");
    void shutdown("uncaughtException").then(() => process.exit(1));
  });
  process.on("unhandledRejection", (error) => {
    logger.error(
      { error: safeErrorMessage(error) },
      "Unhandled service rejection"
    );
  });

  logger.info({ dataDir: config.dataDir }, "Sky service starting");
  db.setServiceState("runtime", {
    state: "starting",
    pid: process.pid,
    startedAt
  });
  await transport.start(secrets.discordBotToken);
  db.recoverInterruptedWork();
  await roleplay.recoverIncomplete();
  curation.start();
  db.setServiceState("runtime", {
    state: "running",
    pid: process.pid,
    startedAt,
    gateway: transport.gatewayStatus()
  });
  timers.heartbeat = setInterval(() => {
    db.setServiceState("runtime", {
      state: "running",
      pid: process.pid,
      startedAt,
      heartbeatAt: new Date().toISOString(),
      gateway: transport.gatewayStatus()
    });
  }, 10_000);
  timers.health = setInterval(() => {
    void health();
  }, 5 * 60_000);
  void health();
  logger.info(
    { gateway: transport.gatewayStatus() },
    "Sky service is ready"
  );
}

void main().catch((error) => {
  process.stderr.write(`Sky failed to start: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
