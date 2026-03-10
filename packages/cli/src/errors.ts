export type CliErrorCode =
  | "API_ERROR"
  | "AUTH_ERROR"
  | "BATCH_INPUT_ERROR"
  | "INVALID_INPUT"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export class OobApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OobApiError";
  }
}

export class CliError extends Error {
  constructor(
    public readonly code: CliErrorCode,
    public readonly exitCode: number,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function classifyError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof OobApiError) {
    if (error.status === 401 || error.status === 403) {
      return new CliError("AUTH_ERROR", 4, error.message, error.status);
    }
    if (error.status === 404) {
      return new CliError("NOT_FOUND", 2, error.message, error.status);
    }
    return new CliError("API_ERROR", 5, error.message, error.status);
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("fetch failed") || message.includes("timed out") || error.name === "AbortError") {
      return new CliError("NETWORK_ERROR", 5, error.message);
    }
    return new CliError("INTERNAL_ERROR", 1, error.message);
  }
  return new CliError("INTERNAL_ERROR", 1, "Unknown error");
}
