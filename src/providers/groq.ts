import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GROQ_TRANSCRIPTION_URL } from "../constants.js";
import { ProviderError } from "../errors.js";
import { fetchWithTimeout, safeProviderError } from "./http.js";

const TranscriptionSchema = z.object({ text: z.string() });

export class GroqTranscriber {
  public constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 120_000
  ) {}

  public async transcribe(filePath: string, contentType: string): Promise<string> {
    const bytes = await readFile(filePath);
    if (bytes.byteLength === 0) {
      throw new ProviderError("Groq", "audio file is empty", 400, false);
    }
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: contentType }),
      path.basename(filePath)
    );
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "json");
    form.append("temperature", "0");
    const response = await fetchWithTimeout(
      GROQ_TRANSCRIPTION_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form
      },
      this.timeoutMs
    );
    if (!response.ok) throw await safeProviderError("Groq", response);
    const transcript = TranscriptionSchema.parse(await response.json()).text.trim();
    if (!transcript) {
      throw new ProviderError(
        "Groq",
        "transcription was empty",
        undefined,
        false
      );
    }
    return transcript;
  }

  public async ready(): Promise<boolean> {
    const response = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/models",
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      15_000
    );
    if (!response.ok) throw await safeProviderError("Groq", response);
    const body = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    return Boolean(
      body.data?.some((model) => model.id === "whisper-large-v3-turbo")
    );
  }
}
