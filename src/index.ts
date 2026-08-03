import { loadConfig } from "./config";
import { createApp } from "./api";
import { MCPServer } from "./mcp-server";
import { BrowserClient } from "./browser-client";
import { UpstreamClient } from "./upstream-client";
import { ChromeManager } from "./chrome-manager";
import { createDiscoveryResponder } from "./mcp-announce";
import { collectable, PageRegistry } from "./page-registry";

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
    userDataDir: config.browser.userDataDir,
    deviceScaleFactor: config.browser.deviceScaleFactor,
  });

  const upstream = new UpstreamClient({
    browserUrl,
    ensureBrowser: () => chrome.ensureRunning(),
    // Wedge recovery: kill + relaunch the shared Chrome, then the child re-attaches.
    restartBrowser: async () => {
      await chrome.stop();
      await chrome.ensureRunning();
    },
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

  const pages = new PageRegistry();

  /**
   * Close tabs nobody wants any more.
   *
   * Nothing has ever closed a tab on this browser: the only cleanup is the
   * whole-Chrome idle reaper, and because it measures time since *any*
   * activity, an instance in daily use never reaches it. Tabs therefore
   * accumulate for the life of the container.
   *
   * Off by default, because the shared instance is in use and this changes
   * behaviour for clients that never asked for it. `log` is the honest first
   * step — it names what it would close and closes nothing, which is how you
   * find out whether an instance really leaks before acting on it.
   */
  if (config.pages.collector !== "off") {
    const mode = config.pages.collector;
    console.log(`Page collector: ${mode} (ttl ${Math.round(config.pages.ttlMs / 60_000)}min)`);

    const sweep = setInterval(async () => {
      if (!chrome.isRunning()) return;
      try {
        const live = pages.observe(await browserClient.listTargets());
        for (const { page, reason } of collectable(live, Date.now(), config.pages.ttlMs)) {
          const age = Math.round((Date.now() - page.lastChangedAt) / 60_000);
          const who = page.owner ?? "nobody";
          const what = `${page.pageId} (${reason}, owner=${who}, idle ${age}min): ${page.url}`;
          if (mode === "log") {
            console.log(`[collector] would close ${what}`);
            continue;
          }
          console.log(`[collector] closing ${what}`);
          await browserClient.closePage(page.pageId).catch(() => {});
          pages.forget(page.pageId);
        }
      } catch (err) {
        console.warn("Page collector sweep failed:", err);
      }
    }, 60_000);
    sweep.unref?.();
  }

  const { app, attachWebSocket } = createApp(mcpServer, browserClient, chrome, pages);
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
