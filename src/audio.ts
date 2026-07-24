import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SkyError } from "./errors.js";
import { fetchWithTimeout } from "./providers/http.js";

export const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "audio/flac",
  "audio/x-m4a",
  "video/mp4",
  "video/webm"
]);

export async function downloadAudio(input: {
  url: string;
  contentType: string;
  expectedSize: number;
  targetDir: string;
  basename: string;
}): Promise<string> {
  if (
    !input.contentType.startsWith("audio/") &&
    !SUPPORTED_AUDIO_TYPES.has(input.contentType)
  ) {
    throw new SkyError(
      `Unsupported voice-message type: ${input.contentType || "unknown"}`,
      "UNSUPPORTED_AUDIO"
    );
  }
  if (input.expectedSize <= 0 || input.expectedSize > 100 * 1024 * 1024) {
    throw new SkyError(
      "Voice message size is invalid or exceeds 100 MB",
      "UNSUPPORTED_AUDIO"
    );
  }
  await mkdir(input.targetDir, { recursive: true });
  const safeBase = input.basename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const target = path.join(input.targetDir, `${randomUUID()}-${safeBase}`);
  const partial = `${target}.part`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchWithTimeout(
        input.url,
        { headers: { Accept: "audio/*,video/mp4,video/webm" } },
        60_000
      );
      if (!response.ok) {
        throw new SkyError(
          `Discord attachment download failed (${response.status})`,
          "DOWNLOAD_FAILED",
          response.status === 429 || response.status >= 500
        );
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.byteLength === 0 || data.byteLength > 100 * 1024 * 1024) {
        throw new SkyError(
          "Downloaded voice message was empty or oversized",
          "DOWNLOAD_FAILED"
        );
      }
      await writeFile(partial, data, { flag: "wx", mode: 0o600 });
      await rename(partial, target);
      return target;
    } catch (error) {
      lastError = error;
      await unlink(partial).catch(() => undefined);
      if (
        error instanceof SkyError &&
        !error.retryable
      )
        break;
    }
  }
  throw lastError;
}

export interface EncodedVoice {
  ogg: Buffer;
  durationSeconds: number;
  waveform: string;
}

export async function encodeDiscordVoice(
  pcm: Buffer,
  ffmpegPath: string
): Promise<EncodedVoice> {
  if (pcm.length < 2 || pcm.length % 2 !== 0) {
    throw new SkyError("TTS returned invalid PCM audio", "AUDIO_ENCODING");
  }
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "1",
    "-i",
    "pipe:0",
    "-c:a",
    "libopus",
    "-b:a",
    "32k",
    "-application",
    "voip",
    "-vbr",
    "on",
    "-f",
    "ogg",
    "pipe:1"
  ];
  const ogg = await runFfmpeg(ffmpegPath, args, pcm);
  const durationSeconds = pcm.length / (48_000 * 2);
  return {
    ogg,
    durationSeconds,
    waveform: buildWaveform(pcm, durationSeconds)
  };
}

function runFfmpeg(
  executable: string,
  args: string[],
  input: Buffer
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else
        reject(
          new SkyError(
            `FFmpeg failed (${code ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8").slice(0, 400)}`,
            "AUDIO_ENCODING"
          )
        );
    });
    child.stdin.end(input);
  });
}

function buildWaveform(pcm: Buffer, durationSeconds: number): string {
  const samples = pcm.length / 2;
  const points = Math.max(
    1,
    Math.min(256, Math.ceil(durationSeconds * 10))
  );
  const chunkSize = Math.max(1, Math.floor(samples / points));
  const waveform = Buffer.alloc(points);
  for (let point = 0; point < points; point++) {
    const start = point * chunkSize;
    const end = Math.min(samples, start + chunkSize);
    let peak = 0;
    for (let sample = start; sample < end; sample++) {
      const value = Math.abs(pcm.readInt16LE(sample * 2));
      if (value > peak) peak = value;
    }
    waveform[point] = Math.min(255, Math.round((peak / 32767) * 255));
  }
  return waveform.toString("base64");
}

export async function detectFfmpeg(
  configured?: string
): Promise<{ ok: boolean; path?: string; detail: string }> {
  const candidates = [
    configured,
    process.env.SKY_FFMPEG_PATH,
    "ffmpeg.exe",
    "ffmpeg"
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const result = await new Promise<boolean>((resolve) => {
      const child = spawn(candidate, ["-version"], {
        stdio: "ignore",
        windowsHide: true
      });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    if (result) {
      return { ok: true, path: candidate, detail: `FFmpeg available at ${candidate}` };
    }
  }
  return {
    ok: false,
    detail:
      "FFmpeg was not found. Run `winget install --id Gyan.FFmpeg --exact` in an elevated terminal, then reopen the terminal."
  };
}

export async function verifyEncodedAudio(
  encodedPath: string
): Promise<boolean> {
  const info = await stat(encodedPath);
  return info.size > 0;
}
