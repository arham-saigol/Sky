import { mkdirSync } from "node:fs";
import path from "node:path";
import pino, { type Logger } from "pino";
import type { SkyConfig } from "./config.js";
import { redact, redactUnknown } from "./redaction.js";

export function createLogger(config: SkyConfig): Logger {
  const logDir = path.join(config.dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const destination = pino.destination({
    dest: path.join(logDir, "sky.log"),
    sync: false,
    mkdir: true
  });
  return pino(
    {
      level: config.logLevel,
      base: { app: "sky" },
      redact: {
        paths: [
          "*.apiKey",
          "*.token",
          "*.authorization",
          "*.reasoning",
          "*.thinking",
          "*.analysis",
          "req.headers.authorization",
          "headers.authorization",
          "headers.x-api-key"
        ],
        censor: "[REDACTED]"
      },
      hooks: {
        logMethod(args, method) {
          const safe = args.map((item) =>
            typeof item === "string" ? redact(item) : redactUnknown(item)
          );
          return method.apply(this, safe as Parameters<typeof method>);
        }
      }
    },
    destination
  );
}
