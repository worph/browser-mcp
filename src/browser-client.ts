import { chromium, Browser, BrowserContext, Page } from "playwright-core";
import { BrowserStatus, ConsoleEntry } from "./types";
import { getConfig } from "./config";

const MAX_CONSOLE_ENTRIES = 1000;

export class BrowserClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private consoleLogs: ConsoleEntry[] = [];

  async launch(): Promise<void> {
    if (this.browser) return;

    const config = getConfig();
    const { width, height } = config.browser.viewport;

    this.browser = await chromium.launch({
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        `--window-size=${width},${height}`,
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width, height },
    });

    this.page = await this.context.newPage();
    this.setupConsoleListener();

    const defaultUrl = config.browser.defaultUrl;
    if (defaultUrl && defaultUrl !== "about:blank") {
      await this.page.goto(defaultUrl);
    }

    console.log("Browser launched");
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
      this.page = null;
      this.consoleLogs = [];
      console.log("Browser closed");
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
