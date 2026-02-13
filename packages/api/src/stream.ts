/**
 * OrderStreamDO — Durable Object for WebSocket-based real-time order events.
 *
 * Each instance manages a "room" (chainId:collection) and broadcasts
 * events to all connected WebSocket clients.
 *
 * Clients connect via: wss://api.openorderbook.xyz/v1/stream?chainId=8453&collection=0x...
 * Events are pushed by the API worker after order mutations (POST, DELETE).
 */

export class OrderStreamDO {
  private state: DurableObjectState;
  private sessions: Map<WebSocket, { events?: Set<string> }>;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sessions = new Map();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal broadcast endpoint (called by the API worker, not by clients)
    if (url.pathname === "/internal/broadcast") {
      return this.handleBroadcast(request);
    }

    // WebSocket upgrade
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Parse event filter from query params
    const eventsParam = url.searchParams.get("events");
    const eventFilter = eventsParam
      ? new Set(eventsParam.split(",").map((e) => e.trim()).filter(Boolean))
      : undefined;

    // Accept the WebSocket
    this.state.acceptWebSocket(server);
    this.sessions.set(server, { events: eventFilter });

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
   * Handle incoming WebSocket messages from hibernated connections.
   * Required by Durable Objects WebSocket Hibernation API.
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Clients can send ping/pong or update their event filter
    try {
      if (typeof message !== "string") return;
      const data = JSON.parse(message);

      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        return;
      }

      // Allow clients to update their event filter
      if (data.type === "subscribe" && Array.isArray(data.events)) {
        const session = this.sessions.get(ws);
        if (session) {
          session.events = new Set(data.events);
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
   * Broadcast an event to all connected clients.
   * Called internally by the API worker after order mutations.
   */
  private async handleBroadcast(request: Request): Promise<Response> {
    let event: { type: string; order: unknown; timestamp: number };
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

    for (const [ws, session] of this.sessions) {
      try {
        // Check event filter
        if (session.events && !session.events.has(event.type)) {
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

    return new Response(JSON.stringify({ sent }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
