import express, { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import http from "http";
import { z } from "zod";
import { createProxyMiddleware } from "http-proxy-middleware";
import { getConfig, updateConfig } from "./config";
import { MCPServer } from "./mcp-server";
import { BrowserClient, PageGoneError } from "./browser-client";
import { ChromeManager } from "./chrome-manager";
import { PageRegistry } from "./page-registry";

const startedAt = Date.now();

export function createApp(
  mcpServer: MCPServer,
  browserClient: BrowserClient,
  chrome: ChromeManager,
  pages: PageRegistry
): { app: express.Application; attachWebSocket: (server: http.Server) => void } {
  const app = express();

  // Auth is handled by the hash-lock sidecar — app trusts the network
  const webDir = path.join(__dirname, "..", "web");
  app.use(express.static(webDir));

  // ── noVNC: proxy WebSocket to internal websockify ───────────────────────
  const vncProxy = createProxyMiddleware({
    target: "http://127.0.0.1:6080",
    ws: true,
    changeOrigin: true,
    pathRewrite: { "^/vnc/websockify": "/" },
  });
  app.use("/vnc/websockify", vncProxy);

  // Serve noVNC static files
  app.use("/vnc", express.static("/usr/share/novnc"));

  // Mount MCP router BEFORE express.json() — it handles its own body parsing
  app.use("/mcp", mcpServer.createRouter());

  app.use(express.json());

  // ── Status & Info ──────────────────────────────────────────────────────

  /**
   * Health, as distinct from "the process is answering".
   *
   * `/api/status` proves this Node server is up, which is all the container
   * healthcheck used to ask — so a Chrome that exited on every launch attempt
   * reported healthy indefinitely. The distinction that matters is between a
   * browser stopped on purpose (the idle reaper did its job, perfectly
   * healthy) and one that cannot start at all.
   */
  app.get("/api/health", (_req: Request, res: Response) => {
    const state = chrome.state();
    const ok = state.chrome !== "failing";
    res.status(ok ? 200 : 503).json({
      ok,
      node: "up",
      ...state,
      profileDir: chrome.profileDir,
      uptimeMs: Date.now() - startedAt,
    });
  });

  app.get("/api/status", async (_req: Request, res: Response) => {
    try {
      const status = await browserClient.getStatusAsync();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** A tab that has gone is a refusal, never a quiet fallback onto another. */
  function fail(res: Response, err: unknown): void {
    if (err instanceof PageGoneError) {
      res.status(410).json({ error: err.message, pageId: err.pageId });
      return;
    }
    res.status(500).json({ error: String(err) });
  }

  // ── Tabs ───────────────────────────────────────────────────────────────
  //
  // A client that opens its own tab and says so is one the collector will not
  // surprise, and one that never has to guess whether "the current page" is
  // still its own. Everything here is optional: an action with no pageId
  // behaves exactly as it always did.

  app.post("/api/pages", async (req: Request, res: Response) => {
    try {
      const { owner, url } = req.body ?? {};
      const page = await browserClient.newPage(url);
      pages.track(page.pageId, owner ?? null, page.url, page.title);
      res.status(201).json(page);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/pages", async (_req: Request, res: Response) => {
    try {
      // Observe first so tabs other clients opened are folded in, then list —
      // `idleForMs` is what makes the answer readable at a glance.
      pages.observe(await browserClient.listTargets());
      res.json({ pages: pages.list() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** "Someone is looking at this" — the one thing that outranks the collector. */
  app.post("/api/pages/:id/keep", (req: Request, res: Response) => {
    const ttlMs = Number(req.body?.ttlMs) || 15 * 60_000;
    const page = pages.keep(req.params.id, ttlMs);
    if (!page) {
      res.status(410).json({ error: `page "${req.params.id}" is no longer open` });
      return;
    }
    res.json({ pageId: page.pageId, keepUntil: page.keepUntil });
  });

  app.delete("/api/pages/:id", async (req: Request, res: Response) => {
    try {
      const closed = await browserClient.closePage(req.params.id);
      pages.forget(req.params.id);
      res.status(closed ? 200 : 410).json({ closed });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/config", (_req: Request, res: Response) => {
    res.json(getConfig());
  });

  app.put("/api/config", (req: Request, res: Response) => {
    try {
      const updated = updateConfig(req.body);
      res.json(updated);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.errors });
      } else {
        res.status(500).json({ error: String(err) });
      }
    }
  });

  // ── Browser Actions ─────────────────────────────────────────────────

  app.post("/api/navigate", async (req: Request, res: Response) => {
    try {
      const { url, waitUntil, pageId } = req.body;
      if (!url) {
        res.status(400).json({ error: "url is required" });
        return;
      }
      const result = await browserClient.navigate(url, waitUntil, pageId);
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/action", async (req: Request, res: Response) => {
    try {
      const { action, ...params } = req.body;
      let result: unknown;

      switch (action) {
        case "click":
          result = await browserClient.click(params.selector, params, params.pageId);
          break;
        case "type":
          result = await browserClient.type(params.selector, params.text, params.delay, params.pageId);
          break;
        case "evaluate":
          result = await browserClient.evaluate(params.script, params.pageId);
          break;
        case "getText":
          result = await browserClient.getText(params.selector, params.pageId);
          break;
        case "waitFor":
          result = await browserClient.waitFor(params.selector, params, params.pageId);
          break;
        case "goBack":
          result = await browserClient.goBack();
          break;
        case "goForward":
          result = await browserClient.goForward();
          break;
        case "setViewport":
          result = await browserClient.setViewport(params.width, params.height);
          break;
        case "press":
          result = await browserClient.press(params.key, params.selector, params.pageId);
          break;
        case "exists":
          result = await browserClient.exists(params.selector, params.pageId);
          break;
        default:
          res.status(400).json({ error: `Unknown action: ${action}` });
          return;
      }

      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/screenshot", async (req: Request, res: Response) => {
    try {
      const base64 = await browserClient.screenshot(
        undefined,
        undefined,
        typeof req.query.pageId === "string" ? req.query.pageId : undefined
      );
      const buffer = Buffer.from(base64, "base64");
      res.set("Content-Type", "image/png");
      res.send(buffer);
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/vnc-password", (_req: Request, res: Response) => {
    try {
      const password = fs.readFileSync("/tmp/.vnc_password", "utf-8").trim();
      res.json({ password });
    } catch {
      res.json({ password: "" });
    }
  });

  app.post("/api/evaluate", async (req: Request, res: Response) => {
    try {
      const { script, pageId } = req.body;
      if (!script) {
        res.status(400).json({ error: "script is required" });
        return;
      }
      const result = await browserClient.evaluate(script, pageId);
      res.json({ result });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/console", (_req: Request, res: Response) => {
    const logs = browserClient.getConsoleLogs();
    res.json(logs);
  });

  // ── Cookies ─────────────────────────────────────────────────────────

  app.get("/api/cookies", async (_req: Request, res: Response) => {
    try {
      const cookies = await browserClient.getCookies();
      res.json(cookies);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/cookies", async (req: Request, res: Response) => {
    try {
      const result = await browserClient.setCookies(req.body.cookies || []);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete("/api/cookies", async (_req: Request, res: Response) => {
    try {
      const result = await browserClient.clearCookies();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── MCP Server Info ────────────────────────────────────────────────────

  app.get("/api/mcp-server-info", (_req: Request, res: Response) => {
    const config = getConfig();
    const baseUrl = `http://${config.hostname}:${config.port}/mcp`;
    const tools = mcpServer.getToolDefinitions().map((t) => ({
      name: t.name,
      description: t.description,
    }));
    res.json({
      httpUrl: baseUrl,
      tools,
      claudeConfig: {
        mcpServers: {
          "browser-mcp": {
            url: baseUrl,
          },
        },
      },
    });
  });

  // Fallback: serve index.html for any non-API route
  app.get("*", (req: Request, res: Response) => {
    if (!req.path.startsWith("/api") && !req.path.startsWith("/vnc")) {
      res.sendFile(path.join(webDir, "index.html"));
    } else {
      res.status(404).json({ error: "Not found" });
    }
  });

  // Error handler
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  // Attach WebSocket upgrade handler to the HTTP server
  function attachWebSocket(server: http.Server): void {
    server.on("upgrade", (req, socket, head) => {
      if (req.url?.startsWith("/vnc/websockify")) {
        (vncProxy as any).upgrade(req, socket, head);
      }
    });
  }

  return { app, attachWebSocket };
}
