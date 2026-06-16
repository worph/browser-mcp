/**
 * Upstream MCP client — spawns chrome-devtools-mcp as a stdio child process and
 * exposes its tool surface. Our HTTP /mcp endpoint forwards tools/list and
 * tools/call straight to this client, so the server "behaves exactly like the
 * Chrome DevTools MCP".
 *
 * chrome-devtools-mcp attaches to the shared Chrome over CDP (--browserUrl), so
 * it never launches its own browser — the one supervisord starts on display :99
 * is the single source of truth, also visible through noVNC.
 */

import { createRequire } from "module";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const nodeRequire = createRequire(__filename);

export interface UpstreamClientOptions {
  /** CDP endpoint of the shared Chrome, e.g. http://127.0.0.1:9222 */
  browserUrl: string;
}

/** Resolve the chrome-devtools-mcp entrypoint so we can run it with our own node. */
function resolveChromeDevtoolsMcp(): { command: string; baseArgs: string[] } {
  // Allow an explicit override (e.g. a pinned binary or wrapper script).
  const override = process.env.CHROME_DEVTOOLS_MCP_CMD;
  if (override) {
    const parts = override.split(" ").filter(Boolean);
    return { command: parts[0], baseArgs: parts.slice(1) };
  }

  // Resolve the installed package's bin entrypoint and run it with node.
  const pkgJsonPath = nodeRequire.resolve("chrome-devtools-mcp/package.json");
  const pkg = nodeRequire("chrome-devtools-mcp/package.json") as {
    bin?: string | Record<string, string>;
    main?: string;
  };
  const binRel =
    typeof pkg.bin === "string"
      ? pkg.bin
      : pkg.bin?.["chrome-devtools-mcp"] ?? Object.values(pkg.bin ?? {})[0] ?? pkg.main;
  if (!binRel) {
    throw new Error("Could not resolve chrome-devtools-mcp entrypoint from its package.json");
  }
  const entry = path.resolve(path.dirname(pkgJsonPath), binRel);
  return { command: process.execPath, baseArgs: [entry] };
}

export class UpstreamClient {
  private readonly browserUrl: string;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];
  private connecting: Promise<void> | null = null;
  private closed = false;

  constructor(options: UpstreamClientOptions) {
    this.browserUrl = options.browserUrl;
  }

  /** Connect (idempotent). Safe to call repeatedly; concurrent calls share one attempt. */
  async connect(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const { command, baseArgs } = resolveChromeDevtoolsMcp();
    // --browserUrl: attach to the shared Chrome instead of launching one.
    // --no-usage-statistics: this is a hosted server; opt out of telemetry.
    const args = [...baseArgs, "--browserUrl", this.browserUrl, "--no-usage-statistics"];

    const transport = new StdioClientTransport({
      command,
      args,
      // chrome-devtools-mcp only attaches over CDP here, so it needs no DISPLAY.
      env: { ...process.env } as Record<string, string>,
      stderr: "pipe",
    });

    transport.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[chrome-devtools-mcp] ${chunk}`);
    });

    transport.onclose = () => {
      if (this.closed) return;
      console.warn("Upstream chrome-devtools-mcp closed; will reconnect on next call");
      this.client = null;
      this.transport = null;
    };
    transport.onerror = (err) => {
      console.error("Upstream chrome-devtools-mcp transport error:", err.message);
    };

    const client = new Client(
      { name: "browser-mcp-proxy", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    const { tools } = await client.listTools();

    this.client = client;
    this.transport = transport;
    this.tools = tools;
    console.log(`Upstream chrome-devtools-mcp connected: ${tools.length} tools`);
  }

  /** Ensure a live connection, reconnecting if the child crashed. */
  private async ensureConnected(): Promise<Client> {
    if (!this.client) {
      await this.connect();
    }
    if (!this.client) {
      throw new Error("Upstream chrome-devtools-mcp is not available");
    }
    return this.client;
  }

  /** Cached tool definitions (populated on first connect). */
  getTools(): Tool[] {
    return this.tools;
  }

  async listTools(): Promise<Tool[]> {
    await this.ensureConnected();
    return this.tools;
  }

  /** Forward a tool call to chrome-devtools-mcp and return its raw result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.ensureConnected();
    return client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client?.close().catch(() => {});
    this.client = null;
    this.transport = null;
  }
}
