/**
 * ChromeManager — owns the single shared Chrome process on display :99.
 *
 * Chrome's lifecycle lives here (not in supervisord) so we can enforce an idle
 * TTL: after a configurable period with no MCP/REST activity we kill Chrome to
 * reclaim RSS, and respawn it on demand the next time someone uses the server.
 * Both the MCP surface (via UpstreamClient.ensureBrowser) and the REST/web-UI
 * surface (via BrowserClient.launch) funnel through ensureRunning(), so any use
 * both wakes Chrome and counts as activity.
 */

import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { chromium } from "playwright-core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const USER_DATA_DIR = "/tmp/chrome-profile";

export interface ChromeManagerOptions {
  cdpPort: number;
  viewport: { width: number; height: number };
  startUrl: string;
  executablePath?: string;
  /** Kill Chrome after this many ms of inactivity (0 disables the reaper). */
  idleTtlMs: number;
}

export class ChromeManager {
  private readonly opts: ChromeManagerOptions;
  private proc: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private intentionalStop = false;
  private lastActivity = Date.now();
  private inFlight = 0;
  private reaper: NodeJS.Timeout | null = null;
  private onReap?: () => Promise<void> | void;

  constructor(opts: ChromeManagerOptions) {
    this.opts = opts;
  }

  private cdpUrl(): string {
    return `http://127.0.0.1:${this.opts.cdpPort}`;
  }

  recordActivity(): void {
    this.lastActivity = Date.now();
  }

  /** Wrap a tool call so the reaper never kills Chrome mid-operation. */
  beginCall(): void {
    this.inFlight++;
    this.recordActivity();
  }
  endCall(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.recordActivity();
  }

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  /** Ensure Chrome is up (lazy). Records activity. Concurrent callers share one launch. */
  async ensureRunning(): Promise<void> {
    this.recordActivity();
    if (this.isRunning()) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async cdpReachable(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${this.cdpUrl()}/json/version`, { signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Drop session/tab state so a respawn doesn't restore stale tabs (cookies kept). */
  private clearSessionState(): void {
    const def = path.join(USER_DATA_DIR, "Default");
    for (const f of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
      try {
        fs.rmSync(path.join(def, f), { force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(path.join(def, "Sessions"), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  /**
   * Disable Chrome's password-manager "save password?" and "found in a data
   * breach" bubbles. These steal keyboard focus during automated logins (the
   * weak demo/demodemo creds trigger the leak warning) and can derail a flow.
   * The CLI feature flag covers leak detection; the save bubble is only governed
   * by these profile prefs. Merged into the existing Preferences so persisted
   * cookies/state are preserved.
   */
  private seedProfilePrefs(): void {
    const def = path.join(USER_DATA_DIR, "Default");
    const prefsPath = path.join(def, "Preferences");
    let prefs: any = {};
    try {
      prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    } catch {
      /* no existing prefs — start fresh */
    }
    prefs.credentials_enable_service = false;
    prefs.profile = {
      ...(prefs.profile || {}),
      password_manager_enabled: false,
      password_manager_leak_detection: false,
    };
    try {
      fs.mkdirSync(def, { recursive: true });
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    } catch (err) {
      console.warn("Could not seed profile prefs:", err);
    }
  }

  private async doStart(): Promise<void> {
    if (this.proc && this.proc.exitCode !== null) this.proc = null;
    this.clearSessionState();
    this.seedProfilePrefs();

    const exe = this.opts.executablePath || chromium.executablePath();
    const { width, height } = this.opts.viewport;
    this.intentionalStop = false;

    const proc = spawn(
      exe,
      [
        `--remote-debugging-port=${this.opts.cdpPort}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${USER_DATA_DIR}`,
        `--window-size=${width},${height}`,
        "--window-position=0,0",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--no-first-run",
        "--no-default-browser-check",
        // Translate popup; PasswordLeakDetection = the "password found in a data
        // breach" warning that fires on weak automated logins (e.g. demo/demodemo);
        // AutofillServerCommunication stops autofill calling Google servers.
        "--disable-features=Translate,PasswordLeakDetection,AutofillServerCommunication",
        // Don't touch the OS keyring (gnome-keyring) — in a headless container it
        // can block or pop an unlock prompt on first credential use.
        "--password-store=basic",
        // Suppress the crash-restore bubble UI (tab restore itself is prevented
        // by clearSessionState() above; cookies persist via the user-data-dir).
        "--hide-crash-restore-bubble",
        "--disable-session-crashed-bubble",
        this.opts.startUrl || "about:blank",
      ],
      {
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" },
        stdio: "ignore", // Chrome is extremely chatty; drop its stdio
      }
    );

    this.proc = proc;
    proc.on("exit", (code, signal) => {
      if (this.proc === proc) this.proc = null;
      if (this.intentionalStop) {
        console.log("Chrome stopped");
      } else {
        console.warn(`Chrome exited unexpectedly (code=${code} signal=${signal}); will relaunch on next use`);
      }
    });

    console.log(`Chrome launching on ${process.env.DISPLAY || ":99"} (CDP ${this.cdpUrl()})`);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.cdpReachable()) {
        console.log("Chrome ready");
        return;
      }
      if (!this.isRunning()) throw new Error("Chrome exited during startup");
      await sleep(500);
    }
    throw new Error(`Chrome did not expose CDP at ${this.cdpUrl()} within 30s`);
  }

  /** Kill Chrome. Safe to call when already stopped. */
  async stop(): Promise<void> {
    this.intentionalStop = true;
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      // Prefer a clean SIGTERM exit (no "crashed" profile → no tab restore);
      // escalate to SIGKILL only if it lingers.
      proc.kill("SIGTERM");
      for (let i = 0; i < 6 && proc.exitCode === null; i++) await sleep(500);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  }

  /**
   * Start the idle reaper. `onReap` runs just before Chrome is killed (used to
   * tear down the chrome-devtools-mcp child so its RSS is freed too).
   */
  startReaper(onReap: () => Promise<void> | void): void {
    this.onReap = onReap;
    if (this.reaper || this.opts.idleTtlMs <= 0) return;
    // Check often enough to honour short TTLs without busy-spinning on long ones.
    const checkMs = Math.min(60_000, Math.max(5_000, Math.floor(this.opts.idleTtlMs / 4)));
    this.reaper = setInterval(async () => {
      if (!this.isRunning() || this.inFlight > 0) return;
      const idle = Date.now() - this.lastActivity;
      if (idle >= this.opts.idleTtlMs) {
        console.log(`Chrome idle for ${Math.round(idle / 60_000)}min ≥ TTL; reaping to free memory`);
        try {
          await this.onReap?.();
        } catch (err) {
          console.error("Reaper onReap error:", err);
        }
        await this.stop().catch(() => {});
      }
    }, checkMs);
    this.reaper.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    await this.stop();
  }
}
