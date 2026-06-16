import { loadConfig } from "./config";
import { createApp } from "./api";
import { MCPServer } from "./mcp-server";
import { BrowserClient } from "./browser-client";
import { UpstreamClient } from "./upstream-client";
import { ChromeManager } from "./chrome-manager";
import { createDiscoveryResponder } from "./mcp-announce";

async function main(): Promise<void> {
  const config = loadConfig();

  const browserUrl = `http://127.0.0.1:${config.browser.cdpPort}`;

  // ChromeManager owns the shared Chrome lifecycle: lazy start on first use and
  // an idle-TTL reaper that kills it to reclaim RSS, respawning on demand.
  const chrome = new ChromeManager({
    cdpPort: config.browser.cdpPort,
    viewport: config.browser.viewport,
    startUrl: config.browser.defaultUrl,
    executablePath: config.browser.chromeExecutablePath || undefined,
    idleTtlMs: config.browser.idleTtlMs,
  });

  const upstream = new UpstreamClient({
    browserUrl,
    ensureBrowser: () => chrome.ensureRunning(),
  });
  const browserClient = new BrowserClient(chrome);
  const mcpServer = new MCPServer(upstream, chrome);

  // Cache the chrome-devtools-mcp tool surface for discovery/announce, then drop
  // the child. The child lists its static tools without a browser, but a child
  // spawned against a not-yet-launched Chrome won't attach cleanly — so we
  // suspend it and let the first real use establish a fresh child against a live
  // browser. Keeps the server fully idle (no Chrome) until first use.
  try {
    console.log("Caching chrome-devtools-mcp tool surface...");
    await upstream.connect();
    await upstream.suspend();
  } catch (err) {
    console.error("Upstream not ready at startup, will retry on first call:", err);
  }

  // Idle reaper: free Chrome's RSS after the TTL, tearing down the child too.
  chrome.startReaper(async () => {
    await upstream.suspend();
  });

  const { app, attachWebSocket } = createApp(mcpServer, browserClient);
  const port = config.port;

  const server = app.listen(port, () => {
    console.log(`browser-mcp listening on http://localhost:${port}`);
    console.log(`Web UI: http://localhost:${port}`);
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`noVNC: http://localhost:${port}/vnc/vnc_lite.html`);

    // Beacon discovery — advertise the upstream chrome-devtools-mcp tools.
    createDiscoveryResponder({
      name: "browser-mcp",
      description: "Chrome DevTools browser automation — navigate, snapshot, click, network, performance, and more via CDP",
      tools: mcpServer.getToolDefinitions(),
      port: config.port,
      listenPort: parseInt(process.env.DISCOVERY_PORT || "9099"),
    });
  });

  // Wire WebSocket upgrade for noVNC proxy
  attachWebSocket(server);

  // Lazy start: Chrome is NOT launched at boot. It spawns on the first MCP tool
  // call or REST browser action (both funnel through ChromeManager.ensureRunning).
  // Optionally pre-warm at boot so noVNC shows a browser immediately.
  if (config.browser.autoLaunch) {
    (async () => {
      try {
        console.log("Pre-warming shared Chrome...");
        await browserClient.launch();
        console.log("Browser ready");
      } catch (err) {
        console.error("Failed to pre-warm browser:", err);
      }
    })();
  }

  // Graceful shutdown
  function shutdown(signal: string): void {
    console.log(`\nReceived ${signal}, shutting down...`);
    chrome.shutdown().catch(() => {});
    upstream.close().catch(() => {});
    browserClient.close().catch(() => {});
    server.close(() => {
      console.log("HTTP server closed");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
