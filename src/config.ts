import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { CONFIG_VERSION, VOICE_NAMES } from "./constants.js";
import { atomicWriteText } from "./util/atomic-file.js";

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export const ConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  discordApplicationId: z.string().regex(/^\d+$/),
  discordPublicKey: z.string().min(32),
  discordGuildId: z.string().regex(/^\d+$/),
  discordOwnerUserId: z.string().regex(/^\d+$/),
  discordLobbyChannelId: z.string().regex(/^\d+$/),
  defaultVoice: z.enum(VOICE_NAMES),
  dataDir: z.string().min(1),
  logLevel: LogLevelSchema,
  automaticStart: z.boolean(),
  adultConsentAt: z.iso.datetime(),
  configuredAt: z.iso.datetime()
});

export type SkyConfig = z.infer<typeof ConfigSchema>;

export const SecretSchema = z.object({
  openCodeApiKey: z.string().min(1),
  discordBotToken: z.string().min(1),
  groqApiKey: z.string().min(1),
  cartesiaPrimaryApiKey: z.string().min(1),
  cartesiaBackupApiKey: z.string().optional()
});

export type SkySecrets = z.infer<typeof SecretSchema>;

export function skyHome(): string {
  if (process.env.SKY_HOME) return path.resolve(process.env.SKY_HOME);
  const base =
    process.env.PROGRAMDATA ??
    process.env.LOCALAPPDATA ??
    path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "Sky");
}

export function configPath(home = skyHome()): string {
  return path.join(home, "config.json");
}

export async function loadConfig(home = skyHome()): Promise<SkyConfig> {
  const raw = await readFile(configPath(home), "utf8");
  return ConfigSchema.parse(JSON.parse(raw));
}

export async function saveConfig(
  config: SkyConfig,
  home = skyHome()
): Promise<void> {
  await mkdir(home, { recursive: true });
  const validated = ConfigSchema.parse(config);
  await atomicWriteText(
    configPath(home),
    `${JSON.stringify(validated, null, 2)}\n`
  );
}

export function defaultDataDir(home = skyHome()): string {
  return path.join(home, "data");
}
