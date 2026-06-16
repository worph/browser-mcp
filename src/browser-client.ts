import { chromium, Browser, BrowserContext, Page } from "playwright-core";
import { BrowserStatus, ConsoleEntry } from "./types";
import { getConfig } from "./config";
import { ChromeManager } from "./chrome-manager";

const MAX_CONSOLE_ENTRIES = 1000;

export class BrowserClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private consoleLogs: ConsoleEntry[] = [];
  private chrome: ChromeManager;

  constructor(chrome: ChromeManager) {
    this.chrome = chrome;
  }

  async launch(): Promise<void> {
    if (this.browser?.isConnected()) return;
    // Drop a stale handle from a previous Chrome that has since gone away, so we
    // re-attach instead of early-returning on a dead reference.
    if (this.browser && !this.browser.isConnected()) {
      this.browser = null;
      this.context = null;
      this.page = null;
    }

    const config = getConfig();
    const cdpUrl = `http://127.0.0.1:${config.browser.cdpPort}`;

    // Make sure the shared Chrome is up (lazy start / wakes a reaped browser),
    // then attach over CDP. chrome-devtools-mcp drives the same browser, and
    // noVNC mirrors it.
    await this.chrome.ensureRunning();
    this.browser = await this.connectWithRetry(cdpUrl);

    // A normally-launched Chrome exposes a default browser context with an
    // initial page; reuse it so the REST/web-UI surface and the MCP surface
    // operate on the same tab the user sees in noVNC.
    this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.setupConsoleListener();

    const defaultUrl = config.browser.defaultUrl;
    if (defaultUrl && defaultUrl !== "about:blank" && this.page.url() === "about:blank") {
      await this.page.goto(defaultUrl).catch(() => {});
    }

    console.log(`Browser attached over CDP at ${cdpUrl}`);
  }

  private async connectWithRetry(cdpUrl: string): Promise<Browser> {
    const maxAttempts = 30;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await chromium.connectOverCDP(cdpUrl);
      } catch (err) {
        lastErr = err;
        // Chrome may still be starting up under supervisord; back off and retry.
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(
      `Could not attach to Chrome at ${cdpUrl} after ${maxAttempts} attempts: ${String(lastErr)}`
    );
  }

  async close(): Promise<void> {
    if (this.browser) {
      // Disconnect only — Chrome itself is owned by supervisord and stays up.
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
      this.page = null;
      this.consoleLogs = [];
      console.log("Browser detached");
    }
  }

  isRunning(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  getStatus(): BrowserStatus {
    if (!this.isRunning() || !this.page) {
      return { running: false, url: null, title: null, viewport: null };
    }
    const config = getConfig();
    return {
      running: true,
      url: this.page.url(),
      title: null, // title() is async, handled separately
      viewport: config.browser.viewport,
    };
  }

  async getStatusAsync(): Promise<BrowserStatus> {
    if (!this.isRunning() || !this.page) {
      return { running: false, url: null, title: null, viewport: null };
    }
    const config = getConfig();
    let title: string | null = null;
    try {
      title = await this.page.title();
    } catch {
      // page may have navigated
    }
    return {
      running: true,
      url: this.page.url(),
      title,
      viewport: config.browser.viewport,
    };
  }

  private setupConsoleListener(): void {
    if (!this.page) return;
    this.page.on("console", (msg) => {
      this.consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
      if (this.consoleLogs.length > MAX_CONSOLE_ENTRIES) {
        this.consoleLogs.shift();
      }
    });
  }

  private async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    if (!this.page || !this.isRunning()) {
      await this.launch();
    }
    try {
      return await fn(this.page!);
    } catch (err) {
      // Check if browser crashed
      if (!this.isRunning()) {
        console.warn("Browser crashed, relaunching...");
        this.browser = null;
        this.context = null;
        this.page = null;
        await this.launch();
        return await fn(this.page!);
      }
      throw err;
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────

  async navigate(url: string, waitUntil?: "load" | "domcontentloaded" | "networkidle"): Promise<{ url: string; title: string }> {
    return this.withPage(async (page) => {
      await page.goto(url, { waitUntil: waitUntil || "load" });
      return { url: page.url(), title: await page.title() };
    });
  }

  async click(selector: string, options?: { button?: "left" | "right" | "middle"; clickCount?: number }): Promise<{ success: true }> {
    return this.withPage(async (page) => {
      await page.click(selector, options);
      return { success: true as const };
    });
  }

  async type(selector: string, text: string, delay?: number): Promise<{ success: true }> {
    return this.withPage(async (page) => {
      await page.fill(selector, text);
      if (delay) {
        // If delay specified, use type() for key-by-key input
        await page.locator(selector).clear();
        await page.type(selector, text, { delay });
      }
      return { success: true as const };
    });
  }

  async screenshot(selector?: string, fullPage?: boolean): Promise<string> {
    return this.withPage(async (page) => {
      let buffer: Buffer;
      if (selector) {
        buffer = await page.locator(selector).screenshot();
      } else {
        buffer = await page.screenshot({ fullPage: fullPage ?? false });
      }
      return buffer.toString("base64");
    });
  }

  async evaluate(script: string): Promise<unknown> {
    return this.withPage(async (page) => {
      return await page.evaluate(script);
    });
  }

  async getText(selector: string): Promise<{ text: string }> {
    return this.withPage(async (page) => {
      const text = await page.locator(selector).textContent() || "";
      return { text };
    });
  }

  async getPageContent(): Promise<string> {
    return this.withPage(async (page) => {
      return await page.content();
    });
  }

  async waitFor(selector: string, options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }): Promise<{ success: true }> {
    return this.withPage(async (page) => {
      await page.locator(selector).waitFor(options);
      return { success: true as const };
    });
  }

  async goBack(): Promise<{ url: string; title: string }> {
    return this.withPage(async (page) => {
      await page.goBack();
      return { url: page.url(), title: await page.title() };
    });
  }

  async goForward(): Promise<{ url: string; title: string }> {
    return this.withPage(async (page) => {
      await page.goForward();
      return { url: page.url(), title: await page.title() };
    });
  }

  async setViewport(width: number, height: number): Promise<{ width: number; height: number }> {
    return this.withPage(async (page) => {
      await page.setViewportSize({ width, height });
      return { width, height };
    });
  }

  getConsoleLogs(clear?: boolean): ConsoleEntry[] {
    const logs = [...this.consoleLogs];
    if (clear) {
      this.consoleLogs = [];
    }
    return logs;
  }

  async pdf(): Promise<string> {
    return this.withPage(async (page) => {
      const buffer = await page.pdf();
      return buffer.toString("base64");
    });
  }

  async getCookies(urls?: string[]): Promise<unknown[]> {
    if (!this.context) throw new Error("Browser not launched");
    const cookies = await this.context.cookies(urls);
    return cookies;
  }

  async setCookies(cookies: Array<{
    name: string;
    value: string;
    url?: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>): Promise<{ success: true }> {
    if (!this.context) throw new Error("Browser not launched");
    await this.context.addCookies(cookies);
    return { success: true as const };
  }

  async clearCookies(): Promise<{ success: true }> {
    if (!this.context) throw new Error("Browser not launched");
    await this.context.clearCookies();
    return { success: true as const };
  }
}
