import { z } from "zod";
import {
  MODEL_IDS,
  OPENCODE_ANTHROPIC_URL,
  OPENCODE_MODELS_URL,
  OPENCODE_OPENAI_URL,
  type ModelId
} from "../constants.js";
import { ProviderError } from "../errors.js";
import { fetchWithTimeout, safeProviderError } from "./http.js";

export interface CleanPrompt {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface RoleplayResult {
  content: string;
  actualModel: ModelId;
  fellBack: boolean;
}

const ModelsSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string()
      })
      .passthrough()
  )
});

const OpenAIResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.union([
          z.string(),
          z.array(
            z.object({
              type: z.string().optional(),
              text: z.string().optional()
            })
          )
        ])
      })
    })
  )
});

const AnthropicResponseSchema = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional()
    })
  )
});

function textFromUnknown(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type?: string; text: string } =>
          Boolean(
            part &&
              typeof part === "object" &&
              "text" in part &&
              typeof part.text === "string" &&
              (!("type" in part) || part.type === "text")
          )
      )
      .map((part) => part.text)
      .join("");
  }
  return "";
}

export class OpenCodeProvider {
  public constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 90_000
  ) {}

  public async listModels(): Promise<Array<Record<string, unknown>>> {
    const response = await fetchWithTimeout(
      OPENCODE_MODELS_URL,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      },
      15_000
    );
    if (!response.ok) throw await safeProviderError("OpenCode Go", response);
    return ModelsSchema.parse(await response.json()).data;
  }

  public async availableRequiredModels(): Promise<{
    available: ModelId[];
    missing: ModelId[];
    metadata: Array<Record<string, unknown>>;
  }> {
    const metadata = await this.listModels();
    const ids = new Set(metadata.map((model) => model.id));
    return {
      available: MODEL_IDS.filter((model) => ids.has(model)),
      missing: MODEL_IDS.filter((model) => !ids.has(model)),
      metadata
    };
  }

  public reasoningModesFromMetadata(
    modelId: ModelId,
    metadata: Array<Record<string, unknown>>
  ): { modes: string[]; source: string } {
    const model = metadata.find((candidate) => candidate.id === modelId);
    if (!model) return { modes: ["default"], source: "model unavailable" };
    if (modelId === "minimax-m3") {
      return {
        modes: ["default"],
        source:
          "OpenCode model metadata exposes no directly mappable selectable Messages API reasoning mode"
      };
    }
    const candidates = [
      model.reasoning_modes,
      model.supported_reasoning_modes,
      model.reasoning_efforts,
      model.supported_reasoning_efforts
    ];
    for (const candidate of candidates) {
      if (
        Array.isArray(candidate) &&
        candidate.every((value) => typeof value === "string")
      ) {
        const verified = [
          "default",
          ...new Set(
            candidate
              .map((value) => value.trim())
              .filter((value) => value && value !== "default")
          )
        ];
        return { modes: verified, source: "OpenCode model metadata" };
      }
    }
    return {
      modes: ["default"],
      source: "OpenCode model metadata exposes no selectable reasoning modes"
    };
  }

  public async roleplay(
    selectedModel: ModelId,
    prompt: CleanPrompt,
    reasoningMode = "default"
  ): Promise<RoleplayResult> {
    try {
      const content = await this.generate(selectedModel, prompt, reasoningMode);
      return { content, actualModel: selectedModel, fellBack: false };
    } catch (error) {
      if (
        selectedModel === "deepseek-v4-pro" &&
        error instanceof ProviderError &&
        error.retryable
      ) {
        const content = await this.generate("hy3", prompt, "default");
        return { content, actualModel: "hy3", fellBack: true };
      }
      throw error;
    }
  }

  public async curate(system: string, user: string): Promise<string> {
    return await this.generate(
      "minimax-m3",
      { system, messages: [{ role: "user", content: user }] },
      "default",
      8192
    );
  }

  private async generate(
    model: ModelId,
    prompt: CleanPrompt,
    reasoningMode: string,
    maxTokens = 4096
  ): Promise<string> {
    if (model === "minimax-m3") {
      const response = await fetchWithTimeout(
        OPENCODE_ANTHROPIC_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model,
            system: prompt.system,
            messages: prompt.messages,
            max_tokens: maxTokens
          })
        },
        this.timeoutMs
      );
      if (!response.ok) throw await safeProviderError("OpenCode Go", response);
      const parsed = AnthropicResponseSchema.parse(await response.json());
      const content = parsed.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
        .trim();
      if (!content)
        throw new ProviderError("OpenCode Go", "model returned empty content");
      return content;
    }

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: prompt.system },
        ...prompt.messages
      ],
      max_tokens: maxTokens
    };
    if (reasoningMode !== "default") {
      body.reasoning_effort = reasoningMode;
    }
    const response = await fetchWithTimeout(
      OPENCODE_OPENAI_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      },
      this.timeoutMs
    );
    if (!response.ok) throw await safeProviderError("OpenCode Go", response);
    const parsed = OpenAIResponseSchema.parse(await response.json());
    const content = textFromUnknown(parsed.choices[0]?.message.content).trim();
    if (!content)
      throw new ProviderError("OpenCode Go", "model returned empty content");
    return content;
  }
}
