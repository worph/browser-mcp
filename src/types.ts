import { z } from "zod";

// ── Config Schemas ─────────────────────────────────────────────────────────

export const BrowserConfigSchema = z.object({
  defaultUrl: z.string().default("about:blank"),
  viewport: z.object({
    width: z.number().int().min(320).default(1280),
    height: z.number().int().min(240).default(720),
  }).default({}),
  // Pre-warm Chrome at boot (so noVNC shows a browser immediately). Default off
  // for lazy start — Chrome spawns on first MCP/REST use instead.
  autoLaunch: z.boolean().default(false),
  // CDP remote-debugging port of the shared Chrome launched by supervisord.
  // chrome-devtools-mcp attaches here for the MCP surface; Playwright
  // connectOverCDP attaches here for the REST/web-UI surface.
  cdpPort: z.number().int().min(1).max(65535).default(9222),
  // Path to the Chromium binary the ChromeManager launches. Empty → resolved at
  // runtime from the Playwright-installed Chromium.
  chromeExecutablePath: z.string().default(""),
  // Kill Chrome after this many ms of inactivity to reclaim RSS; it respawns on
  // the next MCP/REST use. Default 2h. Set 0 to disable the reaper.
  idleTtlMs: z.number().int().min(0).default(2 * 60 * 60 * 1000),
});

export const VncConfigSchema = z.object({
  resolution: z.string().default("1280x720x24"),
});

export const AppConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(9746),
  hostname: z.string().default("browsermcp"),
  browser: BrowserConfigSchema.default({}),
  vnc: VncConfigSchema.default({}),
});

export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type VncConfig = z.infer<typeof VncConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

// ── Interfaces ─────────────────────────────────────────────────────────────

export interface BrowserStatus {
  running: boolean;
  url: string | null;
  title: string | null;
  viewport: { width: number; height: number } | null;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
}
