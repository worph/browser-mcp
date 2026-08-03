import fs from "fs";
import path from "path";
import { AppConfig, AppConfigSchema } from "./types";

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), "config.json");

let _config: AppConfig = AppConfigSchema.parse({});

export function getConfig(): AppConfig {
  return _config;
}

export function loadConfig(): AppConfig {
  const envOverrides: Record<string, unknown> = {};

  if (process.env.PORT) {
    envOverrides.port = parseInt(process.env.PORT, 10);
  }

  const browserOverrides: Record<string, unknown> = {};
  if (process.env.BROWSER_DEFAULT_URL) browserOverrides.defaultUrl = process.env.BROWSER_DEFAULT_URL;
  if (process.env.CDP_PORT) browserOverrides.cdpPort = parseInt(process.env.CDP_PORT, 10);
  if (process.env.CHROME_EXECUTABLE_PATH) browserOverrides.chromeExecutablePath = process.env.CHROME_EXECUTABLE_PATH;
  if (process.env.IDLE_TTL_MS) browserOverrides.idleTtlMs = parseInt(process.env.IDLE_TTL_MS, 10);
  if (process.env.CHROME_USER_DATA_DIR) browserOverrides.userDataDir = process.env.CHROME_USER_DATA_DIR;
  if (process.env.CHROME_DEVICE_SCALE_FACTOR) {
    browserOverrides.deviceScaleFactor = Number(process.env.CHROME_DEVICE_SCALE_FACTOR);
  }
  if (Object.keys(browserOverrides).length > 0) envOverrides.browser = browserOverrides;

  const pagesOverrides: Record<string, unknown> = {};
  if (process.env.PAGE_COLLECTOR) pagesOverrides.collector = process.env.PAGE_COLLECTOR;
  if (process.env.PAGE_TTL_MS) pagesOverrides.ttlMs = parseInt(process.env.PAGE_TTL_MS, 10);
  if (Object.keys(pagesOverrides).length > 0) envOverrides.pages = pagesOverrides;

  const vncOverrides: Record<string, unknown> = {};
  if (process.env.VNC_RESOLUTION) vncOverrides.resolution = process.env.VNC_RESOLUTION;
  if (Object.keys(vncOverrides).length > 0) envOverrides.vnc = vncOverrides;

  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`Config file not found at ${CONFIG_PATH}, using defaults`);
    _config = AppConfigSchema.parse(envOverrides);
    return _config;
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const merged = {
      ...parsed,
      ...envOverrides,
      browser: { ...(parsed.browser || {}), ...(browserOverrides) },
      vnc: { ...(parsed.vnc || {}), ...(vncOverrides) },
    };
    _config = AppConfigSchema.parse(merged);
    console.log(`Config loaded from ${CONFIG_PATH}`);
    return _config;
  } catch (err) {
    console.error("Failed to load config:", err);
    throw err;
  }
}

export function saveConfig(config: AppConfig): void {
  _config = config;
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  console.log(`Config saved to ${CONFIG_PATH}`);
}

export function updateConfig(partial: Partial<AppConfig>): AppConfig {
  const updated = AppConfigSchema.parse({ ..._config, ...partial });
  saveConfig(updated);
  return updated;
}
