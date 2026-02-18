/**
 * Request audit logging for write operations.
 * Logs structured JSON to console (captured by Cloudflare Workers Logs).
 */

import type { Env } from "./types.js";

export function logRequestAudit(
    request: Request,
    env: Env,
    path: string,
): void {
    try {
        const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
        const apiKey = request.headers.get("x-api-key");
        const userAgent = request.headers.get("user-agent") || "unknown";
        const contentLength = Number(request.headers.get("content-length") || "0");

        // Hash API key for logging (don't log full key)
        let apiKeyPrefix = "";
        if (apiKey) {
            apiKeyPrefix = apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : "***";
        }

        console.log(JSON.stringify({
            audit: true,
            timestamp: new Date().toISOString(),
            method: request.method,
            path,
            ip,
            apiKey: apiKeyPrefix || null,
            userAgent,
            contentLength,
            source: apiKey ? "registered" : "public",
        }));
    } catch {
        // Audit logging should never break request processing
    }
}
