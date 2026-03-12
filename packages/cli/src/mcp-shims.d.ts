// Type shims for dynamic imports — these modules are loaded at runtime only when needed.
declare module "ws" {
  const WebSocket: any;
  export default WebSocket;
}

declare module "@modelcontextprotocol/sdk/server/index.js" {
  export class Server {
    constructor(info: { name: string; version: string }, options: { capabilities: Record<string, unknown> });
    setRequestHandler(schema: unknown, handler: (request: any) => Promise<any>): void;
    connect(transport: unknown): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/server/stdio.js" {
  export class StdioServerTransport {
    constructor();
  }
}
