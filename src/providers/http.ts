import { ProviderError } from "../errors.js";

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "request timed out"
        : "network request failed";
    throw new ProviderError(new URL(url).hostname, message);
  } finally {
    clearTimeout(timer);
  }
}

export async function safeProviderError(
  provider: string,
  response: Response
): Promise<ProviderError> {
  let detail = response.statusText;
  try {
    const body = (await response.json()) as any;
    const value =
      body?.error?.message ?? body?.message ?? body?.error?.type ?? undefined;
    if (typeof value === "string") detail = value.slice(0, 240);
  } catch {
    // Do not retain raw provider payloads.
  }
  return new ProviderError(
    provider,
    `request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    response.status
  );
}
