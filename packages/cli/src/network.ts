import { setTimeout as delay } from "node:timers/promises";
import { OobApiError } from "./errors.js";

export interface NetworkConfig {
  apiKey?: string;
  apiUrl: string;
  retryDelayMs: number;
  retries: number;
  timeoutMs: number;
}

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }

  return headers;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function shouldRetry(error: unknown, attempt: number, retries: number): boolean {
  if (attempt >= retries) {
    return false;
  }
  if (error instanceof OobApiError) {
    return isRetryableStatus(error.status);
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return error.name === "AbortError" || message.includes("fetch failed") || message.includes("timed out");
  }
  return false;
}

async function readErrorMessage(response: Response): Promise<string> {
  let message = `API error ${response.status}`;
  try {
    const body = await response.json() as { error?: string; message?: string };
    if (body.error) {
      message = body.error;
    } else if (body.message) {
      message = body.message;
    }
  } catch {
    const text = await response.text().catch(() => "");
    if (text.trim()) {
      message = text.trim();
    }
  }
  return message;
}

export async function getJson<T>(config: NetworkConfig, path: string): Promise<T> {
  const baseUrl = config.apiUrl.replace(/\/$/, "");

  for (let attempt = 0; attempt <= config.retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${config.timeoutMs}ms`)), config.timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: buildHeaders(config.apiKey),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new OobApiError(response.status, await readErrorMessage(response));
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (!shouldRetry(error, attempt, config.retries)) {
        throw error;
      }
      await delay(config.retryDelayMs * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Unreachable retry state");
}
