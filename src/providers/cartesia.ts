import {
  CARTESIA_API_VERSION,
  CARTESIA_TTS_URL,
  VOICES,
  type Expression,
  type VoiceName
} from "../constants.js";
import { ProviderError } from "../errors.js";
import { fetchWithTimeout, safeProviderError } from "./http.js";

export interface SpeechAudio {
  pcm: Buffer;
  sampleRate: 48_000;
}

function shouldUseBackup(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    (error.retryable ||
      error.status === 401 ||
      error.status === 402 ||
      error.status === 403)
  );
}

export class CartesiaTts {
  public constructor(
    private readonly primaryKey: string,
    private readonly backupKey?: string,
    private readonly timeoutMs = 120_000
  ) {}

  public async synthesize(input: {
    text: string;
    voice: VoiceName;
    expression?: Expression;
  }): Promise<{ audio: SpeechAudio; usedBackup: boolean }> {
    try {
      return {
        audio: await this.requestWithExpressionFallback(this.primaryKey, input),
        usedBackup: false
      };
    } catch (error) {
      if (!this.backupKey || !shouldUseBackup(error)) throw error;
      return {
        audio: await this.requestWithExpressionFallback(this.backupKey, input),
        usedBackup: true
      };
    }
  }

  public async checkKey(key: "primary" | "backup"): Promise<boolean> {
    const apiKey = key === "primary" ? this.primaryKey : this.backupKey;
    if (!apiKey) return false;
    const response = await fetchWithTimeout(
      "https://api.cartesia.ai/voices?limit=1",
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Cartesia-Version": CARTESIA_API_VERSION
        }
      },
      15_000
    );
    if (!response.ok) throw await safeProviderError("Cartesia", response);
    return true;
  }

  private async request(
    apiKey: string,
    input: {
      text: string;
      voice: VoiceName;
      expression?: Expression;
    }
  ): Promise<SpeechAudio> {
    const generationConfig =
      input.expression === undefined ? undefined : { emotion: input.expression };
    const response = await fetchWithTimeout(
      CARTESIA_TTS_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Cartesia-Version": CARTESIA_API_VERSION
        },
        body: JSON.stringify({
          model_id: "sonic-3.5",
          transcript: input.text,
          voice: { mode: "id", id: VOICES[input.voice] },
          language: "en",
          output_format: {
            container: "raw",
            encoding: "pcm_s16le",
            sample_rate: 48_000
          },
          ...(generationConfig ? { generation_config: generationConfig } : {})
        })
      },
      this.timeoutMs
    );
    if (!response.ok) throw await safeProviderError("Cartesia", response);
    const pcm = Buffer.from(await response.arrayBuffer());
    if (pcm.byteLength < 2) {
      throw new ProviderError("Cartesia", "TTS returned empty audio");
    }
    return { pcm, sampleRate: 48_000 };
  }

  private async requestWithExpressionFallback(
    apiKey: string,
    input: {
      text: string;
      voice: VoiceName;
      expression?: Expression;
    }
  ): Promise<SpeechAudio> {
    try {
      return await this.request(apiKey, input);
    } catch (error) {
      if (
        input.expression !== undefined &&
        error instanceof ProviderError &&
        (error.status === 400 || error.status === 422)
      ) {
        return await this.request(apiKey, {
          text: input.text,
          voice: input.voice
        });
      }
      throw error;
    }
  }
}
