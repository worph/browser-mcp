import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { z } from "zod";
import { getConfig, updateConfig } from "./config";
import { MCPServer } from "./mcp-server";
import { BrowserClient } from "./browser-client";

export function createApp(
  mcpServer: MCPServer,
  browserClient: BrowserClient
): express.Application {
  const app = express();

  // Mount MCP router BEFORE express.json() — it handles its own body parsing
  app.use("/mcp", mcpServer.createRouter());

  app.use(express.json());

  // Serve static web UI
  const webDir = path.join(__dirname, "..", "web");
  app.use(express.static(webDir));

  // ── Status & Info ──────────────────────────────────────────────────────

  app.get("/api/status", async (_req: Request, res: Response) => {
    try {
      const status = await browserClient.getStatusAsync();
      res.json(status);
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
      const { url, waitUntil } = req.body;
      if (!url) {
        res.status(400).json({ error: "url is required" });
        return;
      }
      const result = await browserClient.navigate(url, waitUntil);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/action", async (req: Request, res: Response) => {
    try {
      const { action, ...params } = req.body;
      let result: unknown;

      switch (action) {
        case "click":
          result = await browserClient.click(params.selector, params);
          break;
        case "type":
          result = await browserClient.type(params.selector, params.text, params.delay);
          break;
        case "evaluate":
          result = await browserClient.evaluate(params.script);
          break;
        case "getText":
          result = await browserClient.getText(params.selector);
          break;
        case "waitFor":
          result = await browserClient.waitFor(params.selector, params);
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
        default:
          res.status(400).json({ error: `Unknown action: ${action}` });
          return;
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/screenshot", async (_req: Request, res: Response) => {
    try {
      const base64 = await browserClient.screenshot();
      const buffer = Buffer.from(base64, "base64");
      res.set("Content-Type", "image/png");
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/evaluate", async (req: Request, res: Response) => {
    try {
      const { script } = req.body;
      if (!script) {
        res.status(400).json({ error: "script is required" });
        return;
      }
      const result = await browserClient.evaluate(script);
      res.json({ result });
    } catch (err) {
      res.status(500).json({ error: String(err) });
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
    if (!req.path.startsWith("/api")) {
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

  return app;
}
