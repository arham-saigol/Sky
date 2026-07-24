export class SkyError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = false,
    public readonly status?: number
  ) {
    super(message);
    this.name = "SkyError";
  }
}

export class ProviderError extends SkyError {
  public constructor(
    provider: string,
    message: string,
    status?: number,
    retryable = isRetriableStatus(status)
  ) {
    super(`${provider}: ${message}`, "PROVIDER_ERROR", retryable, status);
    this.name = "ProviderError";
  }
}

export function isRetriableStatus(status?: number): boolean {
  return (
    status === undefined ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof SkyError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}
