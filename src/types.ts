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

// ── Tool Input Schemas ─────────────────────────────────────────────────────

export const NavigateSchema = z.object({
  url: z.string(),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
});

export const ClickSchema = z.object({
  selector: z.string(),
  button: z.enum(["left", "right", "middle"]).optional(),
  clickCount: z.number().int().optional(),
});

export const TypeSchema = z.object({
  selector: z.string(),
  text: z.string(),
  delay: z.number().optional(),
});

export const ScreenshotSchema = z.object({
  selector: z.string().optional(),
  fullPage: z.boolean().optional(),
});

export const EvaluateSchema = z.object({
  script: z.string(),
});

export const GetTextSchema = z.object({
  selector: z.string(),
});

export const WaitForSchema = z.object({
  selector: z.string(),
  state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
  timeout: z.number().optional(),
});

export const SetViewportSchema = z.object({
  width: z.number().int().min(320),
  height: z.number().int().min(240),
});

export const CookiesSetSchema = z.object({
  cookies: z.array(z.object({
    name: z.string(),
    value: z.string(),
    url: z.string().optional(),
    domain: z.string().optional(),
    path: z.string().optional(),
    expires: z.number().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  })),
});

export const CookiesGetSchema = z.object({
  urls: z.array(z.string()).optional(),
});

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
