import { afterEach, describe, expect, it, vi } from "vitest";
import { CartesiaTts } from "../src/providers/cartesia.js";
import { OpenCodeProvider } from "../src/providers/opencode.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Cartesia key and expression fallback", () => {
  it("retries unsupported emotion as ordinary speech on the same key", async () => {
    const requests: RequestInit[] = [];
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (_url: string, init?: RequestInit) => {
        requests.push(init ?? {});
        return requests.length === 1
          ? new Response(JSON.stringify({ message: "emotion unsupported" }), {
              status: 422,
              headers: { "Content-Type": "application/json" }
            })
          : new Response(new Uint8Array([1, 0, 2, 0]), { status: 200 });
      }) as typeof fetch;
    const tts = new CartesiaTts("primary", "backup");
    const result = await tts.synthesize({
      text: "Hello",
      voice: "Katie",
      expression: "calm"
    });
    expect(result.usedBackup).toBe(false);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[0]?.body)).generation_config).toEqual({
      emotion: "calm"
    });
    expect(JSON.parse(String(requests[1]?.body)).generation_config).toBeUndefined();
    expect(
      (requests[1]?.headers as Record<string, string>).Authorization
    ).toBe("Bearer primary");
  });

  it("uses the backup key only for an auth/quota/retriable primary failure", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (_url: string, init?: RequestInit) => {
        authorizations.push(
          (init?.headers as Record<string, string>).Authorization
        );
        return authorizations.length === 1
          ? new Response(JSON.stringify({ message: "quota" }), {
              status: 402,
              headers: { "Content-Type": "application/json" }
            })
          : new Response(new Uint8Array([1, 0, 2, 0]), { status: 200 });
      }) as typeof fetch;
    const tts = new CartesiaTts("primary", "backup");
    const result = await tts.synthesize({ text: "Hello", voice: "Gemma" });
    expect(result.usedBackup).toBe(true);
    expect(authorizations).toEqual(["Bearer primary", "Bearer backup"]);
  });
});

describe("OpenCode Go routing", () => {
  it("falls back from DeepSeek to Hy3 only after a retriable provider failure", async () => {
    const requests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        requests.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        if (requests.length === 1) {
          return new Response(
            JSON.stringify({ error: { message: "temporarily unavailable" } }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Hy3 response" } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch;
    const provider = new OpenCodeProvider("test-key");
    const result = await provider.roleplay(
      "deepseek-v4-pro",
      { system: "clean", messages: [{ role: "user", content: "hello" }] },
      "default"
    );
    expect(result).toEqual({
      content: "Hy3 response",
      actualModel: "hy3",
      fellBack: true
    });
    expect(requests.map((request) => request.body.model)).toEqual([
      "deepseek-v4-pro",
      "hy3"
    ]);
  });

  it("does not fall back on a non-retriable request error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad prompt" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      })
    ) as typeof fetch;
    const provider = new OpenCodeProvider("test-key");
    await expect(
      provider.roleplay(
        "deepseek-v4-pro",
        { system: "clean", messages: [{ role: "user", content: "hello" }] },
        "default"
      )
    ).rejects.toMatchObject({ retryable: false, status: 400 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("always sends curation to MiniMax M3 on the Messages endpoint", async () => {
    let request: { url?: string; body?: any } = {};
    globalThis.fetch = vi.fn().mockImplementation(
      async (url: string, init?: RequestInit) => {
        request = {
          url,
          body: JSON.parse(String(init?.body))
        };
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "{\"ok\":true}" }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    ) as typeof fetch;
    const provider = new OpenCodeProvider("test-key");
    await provider.curate("system", "segment");
    expect(request.url).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(request.body.model).toBe("minimax-m3");
  });

  it("exposes only default reasoning when metadata advertises no modes", () => {
    const provider = new OpenCodeProvider("test-key");
    expect(
      provider.reasoningModesFromMetadata("deepseek-v4-pro", [
        { id: "deepseek-v4-pro", object: "model" }
      ])
    ).toEqual({
      modes: ["default"],
      source: "OpenCode model metadata exposes no selectable reasoning modes"
    });
  });
});
