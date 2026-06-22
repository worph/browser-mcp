/**
 * Upstream MCP client — spawns chrome-devtools-mcp as a stdio child process and
 * exposes its tool surface. Our HTTP /mcp endpoint forwards tools/list and
 * tools/call straight to this client, so the server "behaves exactly like the
 * Chrome DevTools MCP".
 *
 * chrome-devtools-mcp attaches to the shared Chrome over CDP (--browserUrl), so
 * it never launches its own browser — the one supervisord starts on display :99
 * is the single source of truth, also visible through noVNC.
 *
 * Crash resilience: if the shared Chrome dies (supervisord restarts it), the
 * child's CDP connection breaks. We detect that — both as a thrown transport
 * error and as a browser-gone tool result — tear down the child, wait for the
 * new Chrome's CDP endpoint to come back, respawn, and retry the failed call
 * once. This keeps multi-step automation alive across a browser crash without
 * an operator restart.
 */

import { createRequire } from "module";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const nodeRequire = createRequire(__filename);

/** Errors thrown by the MCP transport when the child/connection is gone. */
const CONNECTION_ERROR_RE =
  /connection closed|not connected|transport|-32000|econnrefused|epipe|socket hang up|closed/i;

/**
 * Tool-result text signalling the underlying browser/target vanished. Covers
 * both Puppeteer/CDP phrasings and chrome-devtools-mcp's own connect-failure
 * message ("Could not connect to Chrome … Failed to fetch browser webSocket URL").
 */
const BROWSER_GONE_RE =
  /target (page|closed)|session closed|protocol error|browser (has been|was) (closed|disconnected)|browser disconnected|websocket connection clos|no target with given id|connection closed|could not connect to chrome|chrome is not running|failed to fetch browser/i;

/** MCP/transport errors that mean the call exceeded its time budget. */
const TIMEOUT_ERROR_RE = /timed out|timeout|-32001/i;

export interface UpstreamClientOptions {
  /** CDP endpoint of the shared Chrome, e.g. http://127.0.0.1:9222 */
  browserUrl: string;
  /**
   * Ensure the shared Chrome is running before a tool call (ChromeManager owns
   * the lifecycle/TTL). Called on every callTool so a reaped browser wakes up.
   */
  ensureBrowser?: () => Promise<void>;
  /**
   * Hard-restart the shared Chrome (kill + relaunch). Used to recover a *wedged*
   * browser — a reconnect alone re-attaches to the same stuck Chrome, so a
   * timeout/target-gone escalates to this. Automates the operator "just restart
   * it" that previously unwedged long runs.
   */
  restartBrowser?: () => Promise<void>;
  /**
   * Per-tool-call hard timeout (ms). A CDP op that wedges is aborted and
   * recovered instead of hanging until the upstream Beacon tears down the whole
   * agent session (which surfaces as an unhandled TaskGroup error). Defaults to
   * env TOOL_CALL_TIMEOUT_MS or 120000.
   */
  toolCallTimeoutMs?: number;
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
  private readonly ensureBrowser?: () => Promise<void>;
  private readonly restartBrowser?: () => Promise<void>;
  private readonly toolCallTimeoutMs: number;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];
  private establishing: Promise<void> | null = null;
  private closed = false;

  constructor(options: UpstreamClientOptions) {
    this.browserUrl = options.browserUrl;
    this.ensureBrowser = options.ensureBrowser;
    this.restartBrowser = options.restartBrowser;
    this.toolCallTimeoutMs =
      options.toolCallTimeoutMs ?? (Number(process.env.TOOL_CALL_TIMEOUT_MS) || 120_000);
  }

  /** Connect (idempotent). Safe to call repeatedly; concurrent calls share one attempt. */
  async connect(): Promise<void> {
    return this.establish();
  }

  private async establish(): Promise<void> {
    if (this.client) return;
    if (this.establishing) return this.establishing;
    this.establishing = this.doEstablish().finally(() => {
      this.establishing = null;
    });
    return this.establishing;
  }

  private async doEstablish(): Promise<void> {
    // The child lists its (static) tools without a live browser, so we don't
    // wait for Chrome here — ChromeManager guarantees readiness before calls.
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
      // Child exited (e.g. its browser vanished). Drop refs so the next call
      // re-establishes a fresh child.
      if (this.transport === transport) {
        console.warn("Upstream chrome-devtools-mcp closed; will reconnect on next call");
        this.client = null;
        this.transport = null;
      }
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

  /** Tear down the current child and establish a fresh one. Concurrency-safe. */
  private async forceReconnect(): Promise<void> {
    const oldClient = this.client;
    this.client = null;
    this.transport = null;
    if (oldClient) {
      // Closing the client kills the child process; a fresh one re-attaches to
      // the (supervisor-restarted) Chrome.
      await oldClient.close().catch(() => {});
    }
    await this.establish();
  }

  private async ensureConnected(): Promise<Client> {
    if (!this.client) await this.establish();
    if (!this.client) throw new Error("Upstream chrome-devtools-mcp is not available");
    return this.client;
  }

  private isConnectionError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return CONNECTION_ERROR_RE.test(msg);
  }

  private isTimeoutError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return TIMEOUT_ERROR_RE.test(msg);
  }

  /**
   * A well-formed MCP error result. callTool returns this instead of throwing so
   * the proxy always emits valid JSON-RPC — a single failed op can never break
   * the HTTP/SSE stream and crash the upstream Beacon's task group.
   */
  private errorResult(name: string, err: unknown): Record<string, unknown> {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `browser-mcp: tool "${name}" failed: ${msg}` }],
      isError: true,
    };
  }

  /** Detect a tool result whose error text means the browser/target is gone. */
  private isBrowserGoneResult(result: unknown): boolean {
    const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    if (!r?.isError || !Array.isArray(r.content)) return false;
    const text = r.content.map((c) => c?.text ?? "").join(" ");
    return BROWSER_GONE_RE.test(text);
  }

  /** Cached tool definitions (populated on first connect). */
  getTools(): Tool[] {
    return this.tools;
  }

  async listTools(): Promise<Tool[]> {
    // Serve the cached surface so tools/list (polled by aggregators) never wakes
    // a reaped browser or respawns the child.
    if (this.tools.length) return this.tools;
    await this.ensureConnected();
    return this.tools;
  }

  /**
   * Forward a tool call to chrome-devtools-mcp. If the call fails because the
   * browser/connection died, reconnect once and retry — so a Chrome crash mid
   * automation self-heals instead of wedging until an operator restart.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // Wake the (possibly reaped) shared Chrome before forwarding.
    if (this.ensureBrowser) await this.ensureBrowser();
    try {
      const client = await this.ensureConnected();
      // Hard time budget: a wedged CDP op must not hang the whole agent session.
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: this.toolCallTimeoutMs }
      );
      if (this.isBrowserGoneResult(result)) {
        console.warn(`Tool "${name}" reported a dead browser; restarting Chrome and retrying once`);
        return await this.recoverAndRetry(name, args, true);
      }
      return result;
    } catch (err) {
      if (this.isTimeoutError(err)) {
        // A hang almost always means Chrome itself is stuck — a child reconnect
        // re-attaches to the same wedged browser, so escalate to a full restart.
        console.warn(`Tool "${name}" timed out after ${this.toolCallTimeoutMs}ms; restarting Chrome and retrying once`);
        return await this.recoverAndRetry(name, args, true);
      }
      if (this.isConnectionError(err)) {
        console.warn(`Tool "${name}" failed on a closed connection; reconnecting and retrying once`);
        return await this.recoverAndRetry(name, args, false);
      }
      // Any other failure: a clean MCP error result, never a thrown exception
      // through the transport.
      return this.errorResult(name, err);
    }
  }

  /**
   * Recover the browser and retry the call ONCE. `restartChrome` kills+relaunches
   * Chrome (for a wedge/target-gone); otherwise just respawns the child (for a
   * dropped connection to a healthy Chrome). Always resolves to a valid MCP
   * result — on a second failure it returns an error result rather than throwing.
   */
  private async recoverAndRetry(
    name: string,
    args: Record<string, unknown>,
    restartChrome: boolean
  ): Promise<unknown> {
    try {
      if (restartChrome && this.restartBrowser) {
        await this.restartBrowser();
      } else if (this.ensureBrowser) {
        await this.ensureBrowser();
      }
      await this.forceReconnect();
      const client = await this.ensureConnected();
      return await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: this.toolCallTimeoutMs }
      );
    } catch (err) {
      console.error(`Tool "${name}" failed after recovery+retry:`, err instanceof Error ? err.message : err);
      return this.errorResult(name, err);
    }
  }

  /** Tear down the child but stay re-establishable (used by the idle reaper). */
  async suspend(): Promise<void> {
    const oldClient = this.client;
    this.client = null;
    this.transport = null;
    if (oldClient) await oldClient.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client?.close().catch(() => {});
    this.client = null;
    this.transport = null;
  }
}
