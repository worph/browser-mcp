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
  // Where the profile lives: cookies, logins, everything worth keeping. Mount
  // it on a volume. It used to be /tmp/chrome-profile, which is the one
  // directory whose name means discardable — and tmpfs on some hosts.
  userDataDir: z.string().default("/data/chrome-profile"),
  // >1 renders everything larger instead of leaving a viewer to scale it down.
  // Read only at launch; the profile outlives the process, so a restart is cheap.
  deviceScaleFactor: z.number().min(0.5).max(4).default(1),
});

/**
 * Tabs the server did not open still cost memory. `off` keeps today's
 * behaviour exactly; `log` reports what it would close and closes nothing,
 * which is how you find out whether a busy instance actually leaks before
 * acting on it; `on` collects.
 */
export const PageCollectorModeSchema = z.enum(["off", "log", "on"]);

export const PagesConfigSchema = z.object({
  collector: PageCollectorModeSchema.default("off"),
  // How long a tab must sit unchanged before it is fair game.
  ttlMs: z.number().int().min(60_000).default(30 * 60 * 1000),
});

export const VncConfigSchema = z.object({
  resolution: z.string().default("1280x720x24"),
});

export const AppConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(9746),
  hostname: z.string().default("browsermcp"),
  browser: BrowserConfigSchema.default({}),
  pages: PagesConfigSchema.default({}),
  vnc: VncConfigSchema.default({}),
});

export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type PagesConfig = z.infer<typeof PagesConfigSchema>;
export type PageCollectorMode = z.infer<typeof PageCollectorModeSchema>;
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
