import { loadConfig } from "./config";
import { createApp } from "./api";
import { MCPServer } from "./mcp-server";
import { BrowserClient } from "./browser-client";
import { UpstreamClient } from "./upstream-client";
import { createDiscoveryResponder } from "./mcp-announce";

async function main(): Promise<void> {
  const config = loadConfig();

  const browserUrl = `http://127.0.0.1:${config.browser.cdpPort}`;
  const upstream = new UpstreamClient({ browserUrl });
  const browserClient = new BrowserClient();
  const mcpServer = new MCPServer(upstream);

  // Connect to chrome-devtools-mcp before announcing so we advertise its real
  // tool surface. Don't fail startup if Chrome isn't up yet — retry lazily.
  try {
    console.log("Connecting to chrome-devtools-mcp...");
    await upstream.connect();
  } catch (err) {
    console.error("Upstream not ready at startup, will retry on first call:", err);
  }

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

  // Attach to the shared Chrome for the REST/web-UI surface in the background.
  if (config.browser.autoLaunch) {
    (async () => {
      try {
        console.log("Attaching to shared Chrome over CDP...");
        await browserClient.launch();
        console.log("Browser ready");
      } catch (err) {
        console.error("Failed to attach to browser:", err);
      }
    })();
  }

  // Graceful shutdown
  function shutdown(signal: string): void {
    console.log(`\nReceived ${signal}, shutting down...`);
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
