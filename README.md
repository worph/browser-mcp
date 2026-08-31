# Browser MCP

A containerized browser environment exposing browser interaction as MCP tools, with a noVNC web viewer and REST API for programmatic control.

Inspired by [appium-mcp](../appium-mcp) — same architecture pattern, swapping the Android emulator for a headed Chromium browser.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Docker Container (Ubuntu)                  │
│                                             │
│  supervisord                                │
│  ├── Xvfb :99            (virtual display)  │
│  ├── x11vnc              (VNC server)       │
│  ├── noVNC/websockify    (web VNC client)   │
│  ├── Chromium            (headed browser)   │
│  └── Node.js server                         │
│      ├── Express REST API     (:9746)       │
│      ├── MCP SSE endpoint     (:9746/mcp)   │
│      └── Playwright connection              │
│                                             │
│  Ports: 6080 (noVNC), 9746 (API + MCP)     │
└─────────────────────────────────────────────┘
```

## Features

- **noVNC Viewer** — Watch the browser live from any web browser on port 6080
- **REST API** — Programmatic browser control via HTTP endpoints
- **MCP Server** — Expose browser actions as Model Context Protocol tools for LLM agents
- **Headless server compatible** — Runs on any Linux server with no display, no GPU, no X11 forwarding required

## Quick Start

```bash
docker compose up -d
```

- noVNC viewer: `http://localhost:6080`
- API / MCP: `http://localhost:9746`

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Is Chrome up, idle, starting or failing to launch. What the container healthcheck asks |
| `GET` | `/api/status` | Current URL, title, viewport |
| `POST` | `/api/navigate` | Navigate to a URL |
| `POST` | `/api/action` | Perform click, type, scroll actions |
| `GET` | `/api/screenshot` | Capture current page screenshot |
| `POST` | `/api/evaluate` | Execute JavaScript in page context |
| `GET` | `/api/console` | Retrieve console log entries |
| `GET` | `/api/cookies` | Get cookies for current page |
| `POST` | `/api/cookies` | Set cookies |
| `DELETE` | `/api/cookies` | Clear cookies |
| `POST` | `/api/pages` | Open a tab of your own — `{ owner, url }` → `{ pageId }` |
| `GET` | `/api/pages` | Every tab Chrome has, with owner, idle time and any hold |
| `POST` | `/api/pages/:id/keep` | Hold a tab open — "a human is looking at this" |
| `DELETE` | `/api/pages/:id` | Close a tab |
| `WS` | `/api/pages/:id/screencast` | Live view of one tab — JPEG frames out, input in |
| `POST` | `/api/pages/:id/frame` | `{ selector }` → that element's page-space bounds |

### Watching one tab

`Page.startScreencast` is per *target*, so a live view shows the tab you asked for rather than
whichever window the X display happens to be showing. Frames arrive as binary WebSocket messages;
a small JSON text message carries the page size and scroll offset whenever they change, which is
what a client needs to turn a click on its canvas into a click on the page.

Input goes back over the same socket:

```json
{"type":"mouse","action":"mousePressed","x":640,"y":400}
{"type":"key","action":"char","key":"a","text":"a"}
{"type":"wheel","x":10,"y":10,"deltaX":0,"deltaY":240}
```

Coordinates are in **page space** — the client scales them, because the server has no idea how big
anyone's canvas is and several people may be watching the same tab at once.

Watchers share one stream per tab, refcounted: a second viewer does not restart or disturb the
first, and the encode stops when the last one leaves. **A tab with a watcher is held against the
page collector** for `SCREENCAST_KEEP_MS`, renewed while connected — closing a page somebody is
reading is exactly what the ownership model exists to prevent.

`/frame` exists because this server drives the browser as well as showing it: ask where the captcha
or the composer is, and point the view at it. A remote desktop can never answer that question.

Every action takes an optional **`pageId`**. Without one it drives the first tab, exactly as it
always has. With one it drives that tab, and answers **410** if it has gone rather than silently
acting on somebody else's page — this browser is shared, and the tab you opened is not necessarily
the tab that is first.

### Writing scripts for `/api/evaluate`

Both dialects work:

```js
() => document.title          // function declaration, as chrome-devtools-mcp takes
document.title                // bare expression
```

Before 1.1 only the second did. Playwright evaluates a *string* as an expression, so a function
declaration evaluated to a function object and came back as `undefined` — indistinguishable from an
empty result, with no error anywhere. The wrapper now invokes what it is given if it is callable.

## MCP Tools

| Tool | Description |
|------|-------------|
| `navigate` | Navigate to a URL |
| `click` | Click an element by selector |
| `type` | Type text into an element |
| `screenshot` | Capture page screenshot (returned as base64) |
| `evaluate` | Run JavaScript in the page |
| `get_text` | Extract text content from an element |
| `get_page_content` | Get full page HTML |
| `wait_for` | Wait for a selector to appear |
| `go_back` / `go_forward` | Browser history navigation |
| `set_viewport` | Change browser viewport size |
| `get_console_logs` | Retrieve browser console output |
| `pdf` | Generate PDF of current page |
| `press` | Press a key or combination — `Enter`, `Escape`, `Control+V` |
| `exists` | Whether a selector matches, without waiting for it |

## Configuration

### Environment

| Variable | Default | Effect |
|---|---|---|
| `CHROME_USER_DATA_DIR` | `/data/chrome-profile` | Where logins live. **Mount this on a volume.** |
| `CHROME_DEVICE_SCALE_FACTOR` | `1` | `--force-device-scale-factor`. Above 1 renders larger, for a desktop watched through a viewer that scales it down. Read at launch. |
| `IDLE_TTL_MS` | `7200000` | Kill Chrome after this long with no activity. It respawns on next use. |
| `PAGE_COLLECTOR` | `off` | `off` · `log` · `on` — see below |
| `PAGE_TTL_MS` | `1800000` | How long a tab sits unchanged before it may be collected |
| `SCREENCAST_QUALITY` | `60` | JPEG quality for live frames |
| `SCREENCAST_MAX_WIDTH` | `1280` | cap frame width — a retina page would otherwise stream 4x the pixels |
| `SCREENCAST_KEEP_MS` | `120000` | how long a watched tab is held against the collector |
| `VNC_RESOLUTION` | `1280x720x24` | Xvfb framebuffer |
| `BEACON_DISCOVERY_PORT` | `0` (off) | UDP port the beacon discovery responder listens on. **Beacon discovery is off unless you set this**; `9099` is the convention — see below |

### Why this is not headless

Chrome runs **headful on Xvfb**, and noVNC is still here. `--headless=new` is close to a real
browser but not identical, and destinations that care about automation can tell — which matters
when the point of the container is publishing to real sites. The display stays; it simply stopped
being the interface once screencast arrived. noVNC is now break-glass, for the things a per-tab
stream structurally cannot show: Chrome's own UI, native dialogs, a file picker.

> ⚠️ **Upgrading to 1.1.8:** the image no longer declares `VOLUME ["/data/chrome-profile"]`, so
> a deployment that mounts nothing there now gets a **cold profile on every container
> recreate**. That is the intended default — a consumer who never asked for persistence should
> not silently get a browser that remembers logins, and Touchstone's audit sidecar had exactly
> that from 2026-08-23 while its own store listing promised a cold start. If you *do* want the
> logins kept, mount the path, as the table above has always said: a named volume or a bind, and
> either one has always overridden the directive anyway.
>
> ⚠️ **Upgrading from 1.0:** the profile moved from `/tmp/chrome-profile` to
> `/data/chrome-profile`. If you were mounting the old path, either remount it at the new one or set
> `CHROME_USER_DATA_DIR=/tmp/chrome-profile`. Getting this wrong loses every login in the profile.
> `/tmp` was never the right home for the one durable thing in the container — it is tmpfs on some
> hosts.

### Collecting abandoned tabs

Nothing used to close a tab. The only cleanup was the whole-Chrome idle reaper, and because it
measures time since *any* activity, an instance in daily use never reaches it — so tabs accumulate
for the life of the container, at 50–300 MB of Chrome RSS each.

`PAGE_COLLECTOR` closes tabs that have sat unchanged for `PAGE_TTL_MS`:

- **`off`** (default) — today's behaviour exactly.
- **`log`** — names what it *would* close and closes nothing. Start here: it tells you whether an
  instance actually leaks before anything is removed from under a live session.
- **`on`** — collects.

It will never close the last remaining tab, never one inside an unexpired `keep`, and never one
whose URL or title has moved inside the TTL. A tab nobody registered is collectable once it is
observably idle, since those are the ones that leak — so **a client that wants its tab left alone
should open it through `POST /api/pages` and renew with `keep`.**

### File

Configuration via `config.json`:

```json
{
  "browser": {
    "defaultUrl": "about:blank",
    "viewport": { "width": 1280, "height": 720 }
  },
  "server": {
    "port": 9746
  },
  "vnc": {
    "port": 6080,
    "resolution": "1280x720x24"
  }
}
```

## Claude Code MCP Setup

Register browser-mcp as an MCP server in Claude Code so tools are available during conversations.

**User level (available in all projects):**
```bash
claude mcp add --scope user --transport http browser-mcp http://localhost:9746/mcp
```

**Project level (current project only):**
```bash
claude mcp add --scope project --transport http browser-mcp http://localhost:9746/mcp
```

> If calling from another container on the `mcp-network`, use the container hostname instead:
> ```bash
> claude mcp add --scope user --transport http browser-mcp http://browsermcp:9746/mcp
> ```

### Beacon MCP discovery

**Off by default.** Set `BEACON_DISCOVERY_PORT=9099` to enable it.

When enabled, the container answers beacon discovery probes so an aggregator can find it without
being told where it is: it binds that UDP port on `0.0.0.0`, joins multicast `239.255.99.1`, and
replies to any `{"type":"discovery"}` datagram with its name, description, MCP port and full tool
manifest. It is purely reactive — nothing is broadcast unprompted.

Unset, `0`, or any non-positive value leaves it off: no socket is bound, no multicast group is
joined, and the server logs `Beacon discovery disabled` at startup. Everything else — the HTTP API,
`/mcp`, noVNC — is unaffected either way; clients configured with an explicit URL never needed
discovery. It defaults off because answering every probe on the network with the full tool surface
is a thing to opt into deliberately, not to inherit.

## Network

Connects to the shared `mcp-network` Docker network for integration with other MCP services (mcp-aggregator, appium-mcp, etc.).
