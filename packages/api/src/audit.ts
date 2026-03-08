/**
 * Request audit logging for write operations.
 * Logs structured JSON to console (captured by Cloudflare Workers Logs).
 */

import type { Env, RequestApiAccess } from "./types.js";
import { resolveRequestApiAccess } from "./subscriptions.js";

export async function logRequestAudit(
    request: Request,
    env: Env,
    path: string,
    access?: RequestApiAccess,
): Promise<void> {
    try {
        const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
        const apiKey = request.headers.get("x-api-key");
        const resolvedAccess = access ?? await resolveRequestApiAccess(request, env);
        const userAgent = request.headers.get("user-agent") || "unknown";
        const contentLength = Number(request.headers.get("content-length") || "0");

        // SHA-256 hash truncated to 8 hex chars — enough to correlate log entries
        // for the same key without exposing any raw key material.
        let apiKeyHash: string | null = null;
        if (apiKey) {
            const encoded = new TextEncoder().encode(apiKey);
            const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
            apiKeyHash = Array.from(new Uint8Array(hashBuffer))
                .map(b => b.toString(16).padStart(2, "0"))
                .join("")
                .slice(0, 8);
        }

        console.log(JSON.stringify({
            audit: true,
            timestamp: new Date().toISOString(),
            method: request.method,
            path,
            ip,
            apiKeyHash,
            userAgent,
            contentLength,
            source: resolvedAccess.isRegistered ? "registered" : "public",
        }));
    } catch {
        // Audit logging should never break request processing
    }
}
