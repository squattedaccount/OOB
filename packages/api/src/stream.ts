/**
 * OrderStreamDO — Durable Object for WebSocket-based real-time order events.
 *
 * Each instance manages a "room" (chainId:collection) and broadcasts
 * events to all connected WebSocket clients.
 *
 * Clients connect via: wss://api.openorderbook.xyz/v1/stream?chainId=8453&collection=0x...
 * Events are pushed by the API worker after order mutations (POST, DELETE).
 *
 * Server-side filtering (applied per-session, avoids sending irrelevant events):
 *   - events:      comma-separated event types (e.g. "new_listing,cancellation")
 *   - chainIds:    comma-separated chain IDs (e.g. "1,8453") — for "all" rooms
 *   - collections: comma-separated collection addresses — for "all" rooms
 *
 * Clients can update filters at any time via a JSON message:
 *   { "type": "subscribe", "events": [...], "chainIds": [...], "collections": [...] }
 */

import type { Env } from "./types.js";

interface SessionFilter {
  events?: Set<string>;
  chainIds?: Set<number>;
  collections?: Set<string>;
}

export class OrderStreamDO {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Map<WebSocket, SessionFilter>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal broadcast endpoint (called by the API worker, not by clients)
    if (url.pathname === "/internal/broadcast") {
      // Verify internal auth
      const authHeader = request.headers.get("Authorization");
      const internalSecret = this.env.INTERNAL_SECRET;
      if (!internalSecret) {
        console.error("[oob-stream] INTERNAL_SECRET not configured — broadcast rejected");
        return new Response("Internal endpoint not configured", { status: 503 });
      }
      if (authHeader !== `Bearer ${internalSecret}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      return this.handleBroadcast(request);
    }

    // WebSocket upgrade
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Parse filters from query params
    const filter = this.parseFilterFromParams(url.searchParams);

    // Accept the WebSocket
    this.state.acceptWebSocket(server);
    this.sessions.set(server, filter);

    server.addEventListener("close", () => {
      this.sessions.delete(server);
    });

    server.addEventListener("error", () => {
      this.sessions.delete(server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Parse subscription filters from URL search params or a subscribe message.
   */
  private parseFilterFromParams(params: URLSearchParams): SessionFilter {
    const filter: SessionFilter = {};

    const eventsParam = params.get("events");
    if (eventsParam) {
      filter.events = new Set(eventsParam.split(",").map((e) => e.trim()).filter(Boolean));
    }

    const chainIdsParam = params.get("chainIds");
    if (chainIdsParam) {
      filter.chainIds = new Set(
        chainIdsParam.split(",").map((c) => Number(c.trim())).filter((n) => Number.isFinite(n)),
      );
    }

    const collectionsParam = params.get("collections");
    if (collectionsParam) {
      filter.collections = new Set(
        collectionsParam.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean),
      );
    }

    return filter;
  }

  /**
   * Handle incoming WebSocket messages from hibernated connections.
   * Required by Durable Objects WebSocket Hibernation API.
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Clients can send ping/pong or update their subscription filters
    try {
      if (typeof message !== "string") return;
      const data = JSON.parse(message);

      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        return;
      }

      // Allow clients to update their subscription filters
      if (data.type === "subscribe") {
        const session = this.sessions.get(ws);
        if (session) {
          if (Array.isArray(data.events)) {
            session.events = new Set(data.events);
          }
          if (Array.isArray(data.chainIds)) {
            session.chainIds = new Set(data.chainIds.map(Number).filter(Number.isFinite));
          }
          if (Array.isArray(data.collections)) {
            session.collections = new Set(data.collections.map((c: string) => String(c).toLowerCase()));
          }
          ws.send(JSON.stringify({ type: "subscribed", filters: {
            events: session.events ? [...session.events] : null,
            chainIds: session.chainIds ? [...session.chainIds] : null,
            collections: session.collections ? [...session.collections] : null,
          }}));
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.sessions.delete(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.sessions.delete(ws);
  }

  /**
   * Check if an event passes a session's filters.
   */
  private matchesFilter(
    filter: SessionFilter,
    eventType: string,
    order: any,
  ): boolean {
    // Event type filter
    if (filter.events && filter.events.size > 0 && !filter.events.has(eventType)) {
      return false;
    }
    // Chain ID filter
    if (filter.chainIds && filter.chainIds.size > 0) {
      const orderChainId = Number(order?.chainId);
      if (!filter.chainIds.has(orderChainId)) return false;
    }
    // Collection filter
    if (filter.collections && filter.collections.size > 0) {
      const orderCollection = String(order?.nftContract || "").toLowerCase();
      if (!filter.collections.has(orderCollection)) return false;
    }
    return true;
  }

  /**
   * Broadcast an event to all connected clients.
   * Called internally by the API worker after order mutations.
   */
  private async handleBroadcast(request: Request): Promise<Response> {
    let event: { type: string; order: any; timestamp: number };
    try {
      event = await request.json() as typeof event;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!event.type || !event.order) {
      return new Response("Missing type or order", { status: 400 });
    }

    const message = JSON.stringify(event);
    let sent = 0;
    let filtered = 0;

    for (const [ws, filter] of this.sessions) {
      try {
        if (!this.matchesFilter(filter, event.type, event.order)) {
          filtered++;
          continue;
        }
        ws.send(message);
        sent++;
      } catch {
        // Dead connection, clean up
        this.sessions.delete(ws);
        try { ws.close(); } catch { /* ignore */ }
      }
    }

    return new Response(JSON.stringify({ sent, filtered }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
