import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response, Router } from "express";
import { UpstreamClient } from "./upstream-client";

/**
 * MCP HTTP server. Exposes the Streamable HTTP transport at /mcp and forwards
 * every tools/list and tools/call to the upstream chrome-devtools-mcp child, so
 * the surface this server advertises is exactly Chrome DevTools MCP's surface.
 */
export class MCPServer {
  private upstream: UpstreamClient;

  constructor(upstream: UpstreamClient) {
    this.upstream = upstream;
  }

  private createServer(): Server {
    const server = new Server(
      { name: "browser-mcp", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers(server);
    return server;
  }

  private setupHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await this.upstream.listTools();
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        // chrome-devtools-mcp returns an MCP CallToolResult; pass it through verbatim.
        const result = await this.upstream.callTool(name, args ?? {});
        return result as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    });
  }

  /** Upstream tool definitions, used for beacon announce and /api/mcp-server-info. */
  getToolDefinitions() {
    return this.upstream.getTools();
  }

  createRouter(): Router {
    const router = Router();

    router.post("/", express.json(), async (req: Request, res: Response) => {
      console.log("MCP HTTP POST request received");
      const server = this.createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });
      res.on("close", () => {
        server.close().catch(console.error);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    return router;
  }

  async stop(): Promise<void> {
    console.log("MCP Server stopped");
  }
}
