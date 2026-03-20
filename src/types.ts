import { z } from "zod";

// ── Config Schemas ─────────────────────────────────────────────────────────

export const BrowserConfigSchema = z.object({
  defaultUrl: z.string().default("about:blank"),
  viewport: z.object({
    width: z.number().int().min(320).default(1280),
    height: z.number().int().min(240).default(720),
  }).default({}),
  autoLaunch: z.boolean().default(true),
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
