import { loadConfig } from "./config";
import { createApp } from "./api";
import { MCPServer } from "./mcp-server";
import { BrowserClient } from "./browser-client";
import { createDiscoveryResponder } from "./mcp-announce";

async function main(): Promise<void> {
  const config = loadConfig();

  const browserClient = new BrowserClient();
  const mcpServer = new MCPServer(browserClient);

  const app = createApp(mcpServer, browserClient);
  const port = config.port;

  const server = app.listen(port, () => {
    console.log(`browser-mcp listening on http://localhost:${port}`);
    console.log(`Web UI: http://localhost:${port}`);
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);

    // Beacon discovery
    createDiscoveryResponder({
      name: "browser-mcp",
      description: "Headless browser automation — navigate, click, type, screenshot, and more via Playwright",
      tools: mcpServer.getToolDefinitions(),
      port: config.port,
      listenPort: parseInt(process.env.DISCOVERY_PORT || "9099"),
    });
  });

  // Auto-launch browser in background
  if (config.browser.autoLaunch) {
    (async () => {
      try {
        console.log("Auto-launching browser...");
        await browserClient.launch();
        console.log("Browser ready");
      } catch (err) {
        console.error("Failed to auto-launch browser:", err);
      }
    })();
  }

  // Graceful shutdown
  function shutdown(signal: string): void {
    console.log(`\nReceived ${signal}, shutting down...`);
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
