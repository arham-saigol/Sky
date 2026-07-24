import { createHash } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkyConfig } from "../config.js";
import { SkyError } from "../errors.js";
import { runProcess } from "./process.js";

const SERVICE_ID = "SkyRoleplay";
const WINSW_RELEASE_API =
  "https://api.github.com/repos/winsw/winsw/releases/latest";
const PINNED_WINSW_SHA256: Record<string, string> = {
  "v2.12.0":
    "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da"
};

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

export class WindowsServiceManager {
  public readonly serviceDir: string;
  public readonly executable: string;
  public readonly xmlPath: string;

  public constructor(private readonly home: string) {
    this.serviceDir = path.join(home, "service");
    this.executable = path.join(this.serviceDir, "SkyService.exe");
    this.xmlPath = path.join(this.serviceDir, "SkyService.xml");
  }

  public async install(config: SkyConfig): Promise<void> {
    await this.prepare(config);
    if (await this.isInstalled()) {
      await this.run(["refresh"]);
    } else {
      await this.run(["install"]);
    }
  }

  public async prepare(config: SkyConfig): Promise<void> {
    this.ensureWindows();
    await mkdir(this.serviceDir, { recursive: true });
    await this.ensureWinSw();
    const nodePath = process.execPath;
    const serviceScript = path.join(projectRoot(), "dist", "service.js");
    await access(serviceScript).catch(() => {
      throw new SkyError(
        "Build Sky before installing the service (`npm run build`)",
        "BUILD_REQUIRED"
      );
    });
    const startMode = config.automaticStart ? "Automatic" : "Manual";
    const document = `<service>
  <id>${SERVICE_ID}</id>
  <name>Sky Roleplay AI</name>
  <description>Self-hosted, single-owner Discord roleplay AI</description>
  <executable>${xml(nodePath)}</executable>
  <arguments>&quot;${xml(serviceScript)}&quot;</arguments>
  <workingdirectory>${xml(projectRoot())}</workingdirectory>
  <env name="SKY_HOME" value="${xml(this.home)}" />
  <startmode>${startMode}</startmode>
  <stoptimeout>150 sec</stoptimeout>
  <stopparentprocessfirst>true</stopparentprocessfirst>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="restart" delay="60 sec" />
  <resetfailure>1 hour</resetfailure>
  <logpath>${xml(path.join(config.dataDir, "logs", "service"))}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>4</keepFiles>
  </log>
</service>
`;
    await writeFile(this.xmlPath, document, { encoding: "utf8", mode: 0o600 });
  }

  public async uninstall(): Promise<void> {
    this.ensureWindows();
    if (await this.isInstalled()) {
      await this.run(["stop"], true);
      await this.run(["uninstall"]);
    }
  }

  public async start(): Promise<void> {
    this.ensureWindows();
    await this.run(["start"]);
  }

  public async stop(): Promise<void> {
    this.ensureWindows();
    await this.run(["stop"]);
  }

  public async restart(): Promise<void> {
    this.ensureWindows();
    const status = await this.status();
    if (status === "stopped") await this.start();
    else await this.run(["restart"]);
  }

  public async status(): Promise<
    "running" | "stopped" | "starting" | "stopping" | "not-installed" | "unknown"
  > {
    if (process.platform !== "win32") return "not-installed";
    const result = await runProcess("sc.exe", ["query", SERVICE_ID]);
    if (result.code !== 0) return "not-installed";
    if (/STATE\s*:\s*\d+\s+RUNNING/i.test(result.stdout)) return "running";
    if (/STATE\s*:\s*\d+\s+STOPPED/i.test(result.stdout)) return "stopped";
    if (/STATE\s*:\s*\d+\s+START_PENDING/i.test(result.stdout))
      return "starting";
    if (/STATE\s*:\s*\d+\s+STOP_PENDING/i.test(result.stdout))
      return "stopping";
    return "unknown";
  }

  public async isInstalled(): Promise<boolean> {
    return (await this.status()) !== "not-installed";
  }

  private async ensureWinSw(): Promise<void> {
    try {
      await access(this.executable);
      return;
    } catch {
      // Download and verify the official release.
    }
    const releaseResponse = await fetch(WINSW_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Sky-Setup"
      }
    });
    if (!releaseResponse.ok) {
      throw new SkyError(
        `Could not fetch the official WinSW release (${releaseResponse.status})`,
        "WINSW_DOWNLOAD"
      );
    }
    const release = (await releaseResponse.json()) as {
      tag_name?: string;
      assets?: GitHubAsset[];
    };
    const asset = release.assets?.find((item) => item.name === "WinSW-x64.exe");
    if (!asset) {
      throw new SkyError(
        "The official WinSW release has no x64 executable",
        "WINSW_DOWNLOAD"
      );
    }
    const response = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": "Sky-Setup" }
    });
    if (!response.ok) {
      throw new SkyError(
        `Could not download WinSW (${response.status})`,
        "WINSW_DOWNLOAD"
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    let expected =
      asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : undefined;
    expected ??=
      release.tag_name === undefined
        ? undefined
        : PINNED_WINSW_SHA256[release.tag_name];
    if (!expected) {
      const checksum = release.assets?.find(
        (item) =>
          /sha256/i.test(item.name) &&
          /\.(txt|sha256|sum)$/i.test(item.name)
      );
      if (checksum) {
        const checksumResponse = await fetch(checksum.browser_download_url, {
          headers: { "User-Agent": "Sky-Setup" }
        });
        if (checksumResponse.ok) {
          const text = await checksumResponse.text();
          expected = text
            .split(/\r?\n/)
            .find((line) => line.includes(asset.name))
            ?.match(/[a-fA-F0-9]{64}/)?.[0];
        }
      }
    }
    if (!expected || expected.toLowerCase() !== actual) {
      throw new SkyError(
        "WinSW download could not be verified against an official SHA-256 digest",
        "WINSW_VERIFY"
      );
    }
    await writeFile(this.executable, bytes, { mode: 0o700 });
    await chmod(this.executable, 0o700);
  }

  private async run(args: string[], ignoreFailure = false): Promise<void> {
    await access(this.executable).catch(() => {
      throw new SkyError(
        "Sky's Windows service wrapper is missing; run `sky setup`",
        "SERVICE_NOT_INSTALLED"
      );
    });
    const result = await runProcess(this.executable, args, {
      cwd: this.serviceDir
    });
    if (result.code !== 0 && !ignoreFailure) {
      const detail = `${result.stdout}\n${result.stderr}`.trim().slice(0, 800);
      throw new SkyError(
        `Windows service command failed. Run the terminal as Administrator.${detail ? ` ${detail}` : ""}`,
        "SERVICE_COMMAND"
      );
    }
  }

  private ensureWindows(): void {
    if (process.platform !== "win32") {
      throw new SkyError(
        "Windows service integration requires Windows",
        "WINDOWS_REQUIRED"
      );
    }
  }
}
