#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { loadConfig, skyHome } from "./config.js";
import { SkyDatabase } from "./db.js";
import { printDoctorReport, runDoctor } from "./doctor.js";
import { safeErrorMessage, SkyError } from "./errors.js";
import { runSetup } from "./setup.js";
import { WindowsServiceManager } from "./windows/service-manager.js";

const program = new Command()
  .name("sky")
  .description("Self-hosted Discord roleplay AI")
  .version("1.0.0")
  .showHelpAfterError();

program
  .command("setup")
  .description("Interactively configure or reconfigure Sky")
  .action(async () => {
    await runSetup(skyHome());
  });

program
  .command("start")
  .description("Start the Sky Windows service and confirm Gateway readiness")
  .action(async () => {
    const home = skyHome();
    const config = await loadConfig(home);
    const service = new WindowsServiceManager(home);
    const requestedAt = Date.now();
    await service.start();
    const deadline = Date.now() + 45_000;
    let db: SkyDatabase | undefined;
    try {
      while (Date.now() < deadline) {
        try {
          db ??= new SkyDatabase(path.join(config.dataDir, "sky.sqlite"));
          const runtime = db.getServiceState<{
            state?: string;
            startedAt?: string;
            heartbeatAt?: string;
            gateway?: { connected?: boolean; ping?: number };
          }>("runtime");
          const fresh =
            runtime?.startedAt !== undefined &&
            new Date(runtime.startedAt).getTime() >= requestedAt;
          if (
            fresh &&
            runtime.state === "running" &&
            runtime.gateway?.connected
          ) {
            console.log(
              `Sky is running; Discord Gateway connected (${runtime.gateway.ping ?? -1} ms).`
            );
            return;
          }
        } catch {
          // Service may still be creating its database.
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    } finally {
      db?.close();
    }
    throw new SkyError(
      "The service started but Discord Gateway readiness was not confirmed within 45 seconds. Run `sky logs` and `sky doctor`.",
      "START_TIMEOUT"
    );
  });

program
  .command("stop")
  .description("Gracefully stop the Sky Windows service")
  .action(async () => {
    const service = new WindowsServiceManager(skyHome());
    await service.stop();
    console.log("Sky service stopped.");
  });

program
  .command("restart")
  .description("Gracefully restart the complete Sky Windows service")
  .action(async () => {
    const service = new WindowsServiceManager(skyHome());
    await service.restart();
    console.log(
      "Sky service restart requested. Use `sky status` to confirm readiness."
    );
  });

program
  .command("status")
  .description("Show service and component readiness")
  .action(async () => {
    const home = skyHome();
    const config = await loadConfig(home);
    const service = new WindowsServiceManager(home);
    const serviceState = await service.status();
    const db = new SkyDatabase(path.join(config.dataDir, "sky.sqlite"));
    const runtime = db.getServiceState<{
      state?: string;
      startedAt?: string;
      heartbeatAt?: string;
      gateway?: { connected?: boolean; ping?: number; user?: string };
    }>("runtime");
    const heartbeatAge = runtime?.heartbeatAt
      ? Date.now() - new Date(runtime.heartbeatAt).getTime()
      : Number.POSITIVE_INFINITY;
    const runtimeFresh =
      serviceState === "running" &&
      runtime?.state === "running" &&
      heartbeatAge >= 0 &&
      heartbeatAge < 30_000;
    const uptime =
      runtime?.startedAt && runtimeFresh
        ? formatDuration(Date.now() - new Date(runtime.startedAt).getTime())
        : "n/a";
    console.log(`Service: ${serviceState} (uptime ${uptime})`);
    const gatewayStatus =
      serviceState !== "running"
        ? "disconnected"
        : !runtimeFresh
          ? "unknown — runtime heartbeat is stale"
          : runtime.gateway?.connected
            ? `connected, ${runtime.gateway.ping ?? -1} ms`
            : "disconnected";
    console.log(
      `Discord Gateway: ${gatewayStatus}`
    );
    const sqlite = db.health();
    console.log(`SQLite: ${sqlite.ok ? "healthy" : "unhealthy"} — ${sqlite.detail}`);
    console.log(`Pending dreamer jobs: ${db.pendingCurationCount()}`);
    const health = db.raw
      .prepare(
        `SELECT component, ok, detail, checked_at FROM health_checks
         WHERE component IN ('opencode','groq','cartesia_primary','cartesia_backup','ffmpeg')
         ORDER BY component`
      )
      .all() as Array<{
      component: string;
      ok: number;
      detail: string;
      checked_at: string;
    }>;
    const labels: Record<string, string> = {
      opencode: "OpenCode Go models",
      groq: "Groq",
      cartesia_primary: "Cartesia primary",
      cartesia_backup: "Cartesia backup",
      ffmpeg: "FFmpeg"
    };
    for (const component of Object.keys(labels)) {
      const row = health.find((candidate) => candidate.component === component);
      console.log(
        row
          ? `${labels[component]}: ${row.ok ? "ready" : "not ready"} — ${row.detail} (${row.checked_at})`
          : `${labels[component]}: unknown — no completed health check yet`
      );
    }
    db.close();
  });

program
  .command("logs")
  .description("Show Sky logs")
  .option("-f, --follow", "Follow new log lines")
  .option("-n, --lines <number>", "Number of initial lines", "100")
  .action(async (options: { follow?: boolean; lines: string }) => {
    const config = await loadConfig(skyHome());
    const file = path.join(config.dataDir, "logs", "sky.log");
    const count = Math.max(1, Number.parseInt(options.lines, 10) || 100);
    let contents = await readFile(file, "utf8").catch(() => "");
    const lines = contents.split(/\r?\n/);
    process.stdout.write(`${lines.slice(-count).join("\n")}\n`);
    if (!options.follow) return;
    let offset = Buffer.byteLength(contents);
    console.log("Following logs; press Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        void (async () => {
          const info = await stat(file).catch(() => undefined);
          if (!info) return;
          if (info.size < offset) offset = 0;
          if (info.size === offset) return;
          contents = await readFile(file, "utf8");
          const bytes = Buffer.from(contents);
          process.stdout.write(bytes.subarray(offset).toString("utf8"));
          offset = bytes.length;
        })();
      }, 750);
      const stop = () => {
        clearInterval(timer);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  });

program
  .command("doctor")
  .description("Run actionable local and provider diagnostics")
  .option("--offline", "Skip provider and Discord network checks")
  .action(async (options: { offline?: boolean }) => {
    const report = await runDoctor({ online: !options.offline });
    printDoctorReport(report);
    if (!report.ok) process.exitCode = 1;
  });

void program.parseAsync().catch((error) => {
  process.stderr.write(`Sky: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}
