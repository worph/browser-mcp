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

export interface ChromeManagerOptions {
  cdpPort: number;
  viewport: { width: number; height: number };
  startUrl: string;
  executablePath?: string;
  /** Kill Chrome after this many ms of inactivity (0 disables the reaper). */
  idleTtlMs: number;
  /**
   * Where the profile lives — cookies, logins, everything worth keeping.
   * Mount this on a volume: it is the one durable thing in the container.
   */
  userDataDir: string;
  /**
   * Chrome's device scale factor. >1 renders everything larger, which is what
   * you want when the desktop is watched through a viewer that scales it down.
   * Read only at launch, so changing it needs a restart — cheap, because the
   * profile outlives the process.
   */
  deviceScaleFactor: number;
}

/**
 * What the health endpoint needs to tell a deliberate stop from a broken one.
 *
 * `wedged` is the state this file spent a week unable to describe: a live process handle over
 * a CDP port that answers nothing. See `stateAsync()`.
 */
export type ChromeState = "running" | "starting" | "idle" | "failing" | "wedged";

/**
 * Is this `/proc/<pid>/cmdline` a Chrome *browser* process on our port and our profile?
 *
 * Exact argument matches rather than substrings: `--user-data-dir=/data/chrome-profile-old`
 * is a different profile and must not be swept, and a port number is a prefix of longer ones.
 * `--type=` marks a renderer, GPU or utility child — those are not strays, they belong to
 * whichever browser process spawned them and die with it, so killing them individually would
 * only make a live Chrome unstable.
 */
export function isOurBrowserProcess(args: readonly string[], cdpPort: number, userDataDir: string): boolean {
  if (args.some((a) => a.startsWith("--type="))) return false;
  if (!args.includes(`--remote-debugging-port=${cdpPort}`)) return false;
  return args.includes(`--user-data-dir=${userDataDir}`);
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
  /**
   * Launches that failed back to back. A browser reaped on purpose is healthy;
   * a browser that cannot start is not, and until now the two were
   * indistinguishable from outside — the container reported healthy right
   * through a Chrome that exited on every attempt.
   */
  private consecutiveLaunchFailures = 0;
  private lastLaunchError: string | null = null;
  private lastExitCode: number | null = null;

  constructor(opts: ChromeManagerOptions) {
    this.opts = opts;
  }

  /**
   * Enough for a healthcheck to tell "off on purpose" from "cannot start".
   *
   * Process-handle only, and therefore not enough on its own — see `stateAsync()`, which is
   * what the health endpoint serves.
   */
  state(): {
    chrome: ChromeState;
    consecutiveLaunchFailures: number;
    lastLaunchError: string | null;
    lastExitCode: number | null;
  } {
    const chrome: ChromeState = this.isRunning()
      ? "running"
      : this.starting
        ? "starting"
        : this.consecutiveLaunchFailures > 0
          ? "failing"
          : "idle";
    return {
      chrome,
      consecutiveLaunchFailures: this.consecutiveLaunchFailures,
      lastLaunchError: this.lastLaunchError,
      lastExitCode: this.lastExitCode,
    };
  }

  /**
   * The same answer, confirmed against CDP rather than against a process handle.
   *
   * `state()` asks "do I still hold a live child?", and for a week on one box the answer was
   * yes over a Chrome that could not be driven at all: `stop()` had lost track of the real
   * process, four of them ended up sharing one profile, and the orphan holding port 9222
   * timed out every call. `/api/health` reported `chrome: "running"` throughout, the
   * container reported healthy, and six audits were dispatched into it.
   *
   * So the health surface asks the port. `/json/version` is a plain HTTP endpoint on the CDP
   * socket — it opens no page, drives no session and deliberately does **not** call
   * `recordActivity()`, so polling it every ten seconds cannot keep the idle reaper from ever
   * firing. What it proves is the only thing a caller cares about: that something is there to
   * talk to.
   */
  async stateAsync(): Promise<ReturnType<ChromeManager["state"]> & { cdp: boolean | null }> {
    const base = this.state();
    if (base.chrome !== "running") return { ...base, cdp: null };
    const cdp = await this.cdpReachable();
    return cdp ? { ...base, cdp } : { ...base, chrome: "wedged", cdp };
  }

  get profileDir(): string {
    return this.opts.userDataDir;
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
    this.starting = this.doStart()
      .catch((err) => {
        // Counted rather than only logged: a browser that fails every attempt
        // is the one state the healthcheck has to be able to see.
        this.consecutiveLaunchFailures++;
        this.lastLaunchError = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => {
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

  /**
   * Drop session/tab state so a respawn doesn't restore stale tabs (cookies kept).
   *
   * The Singleton files matter most and are the reason this is not optional.
   * Chrome writes `SingletonLock` as a symlink naming the host and pid that
   * hold the profile; a container that is recreated leaves one pointing at a
   * host that no longer exists, and Chrome then refuses to start at all —
   * exiting 21 on every attempt, forever. It is the one failure mode that
   * persisting the profile introduces, so clearing it is what makes the volume
   * safe to keep.
   */
  private clearSessionState(): void {
    const def = path.join(this.opts.userDataDir, "Default");
    for (const f of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
      try {
        fs.rmSync(path.join(def, f), { force: true });
      } catch {
        /* ignore */
      }
    }
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      try {
        fs.rmSync(path.join(this.opts.userDataDir, f), { force: true });
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
    const def = path.join(this.opts.userDataDir, "Default");
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

  /**
   * Chromes on our profile and our CDP port that we are not tracking.
   *
   * This is the sweep that would have caught the pile-up. Every relaunch here spawns onto a
   * fixed `--remote-debugging-port` and a fixed `--user-data-dir`, so a process we lost track
   * of is not merely untidy: it holds the port the new one needs, and Chrome's second
   * instance quietly gives up its own debugging socket rather than failing. The manager then
   * tracks process B while every CDP call reaches process A, and `clearSessionState()` has
   * meanwhile deleted the singleton files out from under A. Four of them accumulated on one
   * box over eight days.
   *
   * `--type=` marks a renderer, GPU or utility child; killing those individually is both
   * unnecessary (the browser process takes them with it) and harmful, so only the browser
   * process itself is a stray.
   */
  private strayPids(): number[] {
    const found: number[] = [];
    let entries: string[];
    try {
      entries = fs.readdirSync("/proc");
    } catch {
      return found; // not Linux, or no procfs — the sweep is best-effort by design
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid || pid === this.proc?.pid) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
      } catch {
        continue; // it exited while we were looking, or it is not ours to read
      }
      if (!isOurBrowserProcess(raw.split("\0"), this.opts.cdpPort, this.opts.userDataDir)) continue;
      found.push(pid);
    }
    return found;
  }

  /** Kill anything holding our port and profile that we are not tracking. */
  private async killStrays(): Promise<number> {
    const strays = this.strayPids();
    if (strays.length === 0) return 0;
    console.warn(`Found ${strays.length} untracked Chrome(s) on ${this.opts.userDataDir}: ${strays.join(", ")}`);
    for (const pid of strays) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // SIGKILL is immediate but reaping is not, and the port stays bound until it is.
    for (let i = 0; i < 20 && this.strayPids().length > 0; i++) await sleep(250);
    const left = this.strayPids();
    if (left.length > 0) console.error(`Chrome(s) ${left.join(", ")} survived SIGKILL`);
    return strays.length;
  }

  private async doStart(): Promise<void> {
    if (this.proc && this.proc.exitCode !== null) this.proc = null;

    // Before anything touches the profile. `clearSessionState()` below removes the singleton
    // files, which is safe only once we are the sole Chrome on this directory — doing it while
    // another instance is live is precisely how two of them end up sharing one profile.
    await this.killStrays();
    if (await this.cdpReachable()) {
      // Nothing we could identify, yet the port is held. Launching now would produce a Chrome
      // whose CDP socket silently goes nowhere, and the readiness check below would pass
      // against the squatter and call it a success — which is how a failed relaunch came to
      // report `Chrome ready` four times running.
      throw new Error(`CDP port ${this.opts.cdpPort} is already held by a process we do not own`);
    }

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
        `--user-data-dir=${this.opts.userDataDir}`,
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
        // Render everything larger rather than letting a viewer scale it down.
        // Omitted entirely at 1 so the command line stays what it always was.
        ...(this.opts.deviceScaleFactor !== 1
          ? [`--force-device-scale-factor=${this.opts.deviceScaleFactor}`]
          : []),
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
      this.lastExitCode = code;
      if (this.intentionalStop) {
        console.log("Chrome stopped");
      } else {
        console.warn(`Chrome exited unexpectedly (code=${code} signal=${signal}); will relaunch on next use`);
      }
    });

    console.log(`Chrome launching on ${process.env.DISPLAY || ":99"} (CDP ${this.cdpUrl()})`);

    // `doStart()` proved the port was free before spawning, so a socket answering now is
    // ours. Without that guarantee this check passes against whoever already held the port,
    // and reports a launch that never happened as a success.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.cdpReachable()) {
        console.log("Chrome ready");
        this.consecutiveLaunchFailures = 0;
        this.lastLaunchError = null;
        return;
      }
      if (!this.isRunning()) throw new Error("Chrome exited during startup");
      await sleep(500);
    }
    throw new Error(`Chrome did not expose CDP at ${this.cdpUrl()} within 30s`);
  }

  /**
   * Kill Chrome, and do not return until it is actually dead. Safe to call when stopped.
   *
   * Both halves of that sentence are load-bearing, and neither used to hold. The old version
   * nulled `this.proc` first and sent SIGKILL last **without waiting for it**, so `stop()`
   * resolved while Chrome was still alive and `isRunning()` already said it was not. The next
   * `ensureRunning()` then cleared the profile's singleton files under a live process and
   * spawned a second Chrome onto the same port and the same `--user-data-dir`. Repeat every
   * two hours and you get four of them, a CDP socket owned by the oldest, and every call
   * timing out on `Network.enable` while the health endpoint reports `running`.
   *
   * So: wait on the `exit` event rather than polling `exitCode` (which Node only sets once it
   * has reaped the child), and if the process survives both signals, **keep the handle**. A
   * browser we cannot kill is one we must not relaunch over; holding the handle makes
   * `stateAsync()` report `wedged`, the container go unhealthy, and Touchstone record the
   * sections that need a browser as blocked — all of which are true, and none of which
   * silently corrupt the profile.
   */
  async stop(): Promise<void> {
    this.intentionalStop = true;
    const proc = this.proc;
    if (!proc) return;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      this.proc = null;
      return;
    }

    const exited = new Promise<boolean>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve(true);
      proc.once("exit", () => resolve(true));
    });
    const within = async (ms: number): Promise<boolean> =>
      Promise.race([exited, sleep(ms).then(() => false)]);

    // Prefer a clean SIGTERM exit (no "crashed" profile → no tab restore); escalate only if
    // it lingers.
    proc.kill("SIGTERM");
    if (!(await within(3000))) {
      proc.kill("SIGKILL");
      if (!(await within(5000))) {
        console.error(`Chrome (pid ${proc.pid}) survived SIGKILL; keeping the handle rather than relaunching over it`);
        return;
      }
    }
    this.proc = null;
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
