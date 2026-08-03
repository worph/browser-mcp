import { chromium, Browser, BrowserContext, Page } from "playwright-core";
import { BrowserStatus, ConsoleEntry } from "./types";
import { getConfig } from "./config";
import { ChromeManager } from "./chrome-manager";

const MAX_CONSOLE_ENTRIES = 1000;

/** The addressed tab has gone. Distinct from a bad request, and never a fallback. */
export class PageGoneError extends Error {
  constructor(readonly pageId: string) {
    super(`page "${pageId}" is no longer open`);
    this.name = "PageGoneError";
  }
}

export class BrowserClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private consoleLogs: ConsoleEntry[] = [];
  /** Playwright page → CDP target id. Weak so a closed tab is not held alive. */
  private readonly targetIds = new WeakMap<Page, string>();
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

  // ── Tabs ───────────────────────────────────────────────────────────────

  /**
   * Chrome's own view of what is open.
   *
   * Read over CDP's HTTP endpoint rather than from Playwright, because it sees
   * every tab — including the ones `chrome-devtools-mcp` opened, which are
   * exactly the ones that leak and which Playwright's context would only show
   * us if we happened to be attached when they appeared.
   */
  async listTargets(): Promise<Array<{ pageId: string; url: string; title: string }>> {
    const { browser } = getConfig();
    const res = await fetch(`http://127.0.0.1:${browser.cdpPort}/json/list`);
    const targets = (await res.json()) as Array<{ id: string; url: string; title: string; type: string }>;
    return targets
      .filter((t) => t.type === "page")
      .map((t) => ({ pageId: t.id, url: t.url, title: t.title }));
  }

  /** The CDP target id of a Playwright page. Cached — it never changes. */
  private async targetIdOf(page: Page): Promise<string> {
    const cached = this.targetIds.get(page);
    if (cached) return cached;
    const session = await this.context!.newCDPSession(page);
    try {
      const { targetInfo } = (await session.send("Target.getTargetInfo")) as {
        targetInfo: { targetId: string };
      };
      this.targetIds.set(page, targetInfo.targetId);
      return targetInfo.targetId;
    } finally {
      await session.detach().catch(() => {});
    }
  }

  /**
   * Resolve a tab by id.
   *
   * Answers undefined rather than falling back to the current page: acting on
   * the wrong tab because the intended one has gone is the failure this whole
   * addressing scheme exists to prevent.
   */
  private async pageById(pageId: string): Promise<Page | undefined> {
    await this.launch();
    for (const page of this.context!.pages()) {
      if (page.isClosed()) continue;
      if ((await this.targetIdOf(page)) === pageId) return page;
    }
    return undefined;
  }

  /** Open a tab of one's own, rather than sharing whatever is first. */
  async newPage(url?: string): Promise<{ pageId: string; url: string; title: string }> {
    await this.launch();
    const page = await this.context!.newPage();
    if (url) await page.goto(url).catch(() => {});
    return {
      pageId: await this.targetIdOf(page),
      url: page.url(),
      title: await page.title().catch(() => ""),
    };
  }

  async closePage(pageId: string): Promise<boolean> {
    const page = await this.pageById(pageId);
    if (!page) return false;
    await page.close().catch(() => {});
    return true;
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

  /**
   * Run against the working page, re-resolving it if it has gone.
   *
   * The `isClosed()` check is not paranoia: this browser is shared, and
   * `chrome-devtools-mcp` opens and closes tabs on it. Without the check, a
   * client that closed our page left `this.page` pointing at a dead handle
   * forever — `launch()` early-returns while the browser is still connected,
   * so every later call threw until Chrome itself restarted.
   */
  private async withPage<T>(fn: (page: Page) => Promise<T>, pageId?: string): Promise<T> {
    if (pageId) {
      const page = await this.pageById(pageId);
      if (!page) throw new PageGoneError(pageId);
      return fn(page);
    }
    if (!this.page || this.page.isClosed() || !this.isRunning()) {
      this.page = null;
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

  async navigate(url: string, waitUntil?: "load" | "domcontentloaded" | "networkidle", pageId?: string): Promise<{ url: string; title: string }> {
    return this.withPage(async (page) => {
      await page.goto(url, { waitUntil: waitUntil || "load" });
      return { url: page.url(), title: await page.title() };
    }, pageId);
  }

  async click(selector: string, options?: { button?: "left" | "right" | "middle"; clickCount?: number }, pageId?: string): Promise<{ success: true }> {
    return this.withPage(async (page) => {
      await page.click(selector, options);
      return { success: true as const };
    }, pageId);
  }

  async type(selector: string, text: string, delay?: number, pageId?: string): Promise<{ success: true }> {
    return this.withPage(async (page) => {
      await page.fill(selector, text);
      if (delay) {
        // If delay specified, use type() for key-by-key input
        await page.locator(selector).clear();
        await page.type(selector, text, { delay });
      }
      return { success: true as const };
    }, pageId);
  }

  async screenshot(selector?: string, fullPage?: boolean, pageId?: string): Promise<string> {
    return this.withPage(async (page) => {
      let buffer: Buffer;
      if (selector) {
        buffer = await page.locator(selector).screenshot();
      } else {
        buffer = await page.screenshot({ fullPage: fullPage ?? false });
      }
      return buffer.toString("base64");
    }, pageId);
  }

  /**
   * Evaluate a script in the page.
   *
   * Playwright treats a *string* as an expression, so `() => { ... }` used to
   * evaluate to a function object and come back as `undefined` — silently, and
   * indistinguishably from an empty result. `chrome-devtools-mcp`, driving the
   * same Chrome, takes the opposite dialect. Callers now get to write either:
   * the wrapper invokes what it is given if it turns out to be callable.
   */
  async evaluate(script: string, pageId?: string): Promise<unknown> {
    return this.withPage(async (page) => {
      return await page.evaluate(
        `(() => { const __f = (${script}); return typeof __f === "function" ? __f() : __f })()`
      );
    }, pageId);
  }

  /**
   * Is anything matching this selector on the page right now?
   *
   * Deliberately not a wait: presence is usually being tested for *absence*
   * (is the login form gone yet), and waiting for something that should not be
   * there adds its whole timeout to every healthy call.
   */
  async exists(selector: string, pageId?: string): Promise<{ exists: boolean }> {
    return this.withPage(async (page) => {
      const count = await page.locator(selector).count();
      return { exists: count > 0 };
    }, pageId);
  }

  /**
   * Press a key or a combination — `Enter`, `Escape`, `Control+V`.
   *
   * The primitive nothing else here could stand in for: real destinations
   * submit forms with Enter, close modals with Escape, and paste with Ctrl+V.
   * With a selector the element is focused first, which is what makes it
   * usable without a preceding click.
   */
  async press(key: string, selector?: string, pageId?: string): Promise<{ success: true }> {
    return this.withPage(async (page) => {
      if (selector) await page.locator(selector).focus();
      await page.keyboard.press(key);
      return { success: true as const };
    }, pageId);
  }

  async getText(selector: string, pageId?: string): Promise<{ text: string }> {
    return this.withPage(async (page) => {
      const text = await page.locator(selector).textContent() || "";
      return { text };
    }, pageId);
  }

  async getPageContent(pageId?: string): Promise<string> {
    return this.withPage(async (page) => {
      return await page.content();
    }, pageId);
  }

  async waitFor(selector: string, options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }, pageId?: string): Promise<{ success: true }> {
    return this.withPage(async (page) => {
      await page.locator(selector).waitFor(options);
      return { success: true as const };
    }, pageId);
  }

  async goBack(pageId?: string): Promise<{ url: string; title: string }> {
    return this.withPage(async (page) => {
      await page.goBack();
      return { url: page.url(), title: await page.title() };
    }, pageId);
  }

  async goForward(pageId?: string): Promise<{ url: string; title: string }> {
    return this.withPage(async (page) => {
      await page.goForward();
      return { url: page.url(), title: await page.title() };
    }, pageId);
  }

  async setViewport(width: number, height: number, pageId?: string): Promise<{ width: number; height: number }> {
    return this.withPage(async (page) => {
      await page.setViewportSize({ width, height });
      return { width, height };
    }, pageId);
  }

  getConsoleLogs(clear?: boolean): ConsoleEntry[] {
    const logs = [...this.consoleLogs];
    if (clear) {
      this.consoleLogs = [];
    }
    return logs;
  }

  async pdf(pageId?: string): Promise<string> {
    return this.withPage(async (page) => {
      const buffer = await page.pdf();
      return buffer.toString("base64");
    }, pageId);
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
