# Implementation Notes

## Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Base image | Ubuntu 22.04 | Full control over installed packages, no unnecessary bloat |
| Display | Xvfb | Virtual framebuffer — no physical display or GPU needed |
| VNC | x11vnc + noVNC/websockify | Same pattern as appium-mcp, browser-accessible VNC |
| Browser | Chromium (headed) | Runs on DISPLAY=:99, visible through noVNC |
| Automation | Playwright (playwright-core) | Direct CDP connection, no separate driver process needed |
| API | Express | REST endpoints for programmatic control |
| MCP | @modelcontextprotocol/sdk | SSE transport for LLM agent integration |
| Process mgmt | supervisord | Manages all processes in single container |
| Language | TypeScript | Matches appium-mcp, type safety with Zod |

## Display Stack — Why It Works Without a Real Display

The container runs on headless servers with no GPU or display. The display chain is entirely software-based:

1. **Xvfb** creates a virtual X11 display (`:99`) backed by RAM — no hardware needed
2. **Chromium** launches in headed mode targeting `DISPLAY=:99` and renders into that virtual framebuffer
3. **x11vnc** connects to `:99` and serves it as a VNC stream
4. **noVNC + websockify** bridges VNC to WebSocket so users view it in a regular browser tab

No `/dev/kvm` required (unlike Android emulator). Chromium is a standard Linux process.

## Docker Build Plan

```dockerfile
FROM ubuntu:22.04

# System deps: Xvfb, x11vnc, noVNC, supervisord, Chromium deps
# Node.js 20 via NodeSource
# Playwright Chromium via: npx playwright-core install --with-deps chromium

# Multi-stage: builder for TypeScript compilation, final for runtime
```

### Key Packages to Install

**Display/VNC:**
- `xvfb` — virtual framebuffer
- `x11vnc` — VNC server that captures X display
- `novnc` + `websockify` — web-based VNC client
- `supervisor` — process manager

**Browser (via Playwright):**
- `playwright-core install --with-deps chromium` handles Chromium + all system library deps

**Node.js:**
- Node 20 via NodeSource APT repo

## Source Structure

```
browser-mcp/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── config.example.json
├── config.json
├── supervisord.conf
├── web/                     # noVNC customization (optional)
└── src/
    ├── index.ts             # Entry point — starts Express + MCP
    ├── api.ts               # Express REST routes
    ├── browser-client.ts    # Playwright browser management
    ├── mcp-server.ts        # MCP tool definitions and handlers
    ├── config.ts            # Config loading and validation
    └── types.ts             # Shared types
```

## Node.js Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "express": "^4.18.2",
    "playwright-core": "^1.48.0",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.10.0",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.3.2"
  }
}
```

Using `playwright-core` (not `playwright`) — we only need the browser control API, not the test runner.

## Supervisord Programs

| Program | Command | Notes |
|---------|---------|-------|
| `xvfb` | `Xvfb :99 -screen 0 1280x720x24 -ac` | Virtual display at configured resolution |
| `x11vnc` | `x11vnc -display :99 -forever -nopw -rfbport 5900` | Captures display, no password (internal only) |
| `websockify` | `websockify --web /usr/share/novnc 6080 localhost:5900` | Bridges VNC to WebSocket + serves noVNC web UI |
| `mcp-server` | `node /app/dist/index.js` | Express API + MCP server, launches Chromium via Playwright |

## Browser Management (browser-client.ts)

Key design decisions:

- **Single persistent browser context** — Playwright launches Chromium once, reuses it across requests
- **Auto-reconnect** — if Chromium crashes, Playwright relaunches it
- **DISPLAY=:99** — environment variable set so Chromium renders to Xvfb
- **Launch flags**: `--no-sandbox` (running in container), `--disable-dev-shm-usage` (Docker /dev/shm is small by default)

```typescript
// Conceptual approach
const browser = await chromium.launch({
  headless: false,           // headed — renders to Xvfb for noVNC visibility
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  executablePath: '/usr/bin/chromium',  // system chromium from playwright install
});
```

## MCP Server Design

Follow the same pattern as appium-mcp:
- SSE transport on `/mcp` endpoint (shared Express server)
- Each MCP tool maps to a Playwright action
- Screenshots returned as base64-encoded PNG
- Console logs buffered in memory, returned on request

## API Design

REST API mirrors MCP tools for non-LLM consumers:
- JSON request/response
- `GET /api/status` used as health check endpoint
- Screenshot endpoint returns PNG binary with `image/png` content type
- Error responses follow `{ error: string, details?: string }` format

## Docker Compose

```yaml
services:
  browser-mcp:
    build: .
    container_name: browser-mcp
    ports:
      - "9746:9746"   # API + MCP
      - "6080:6080"   # noVNC
    environment:
      - DISPLAY=:99
      - CONFIG_PATH=/app/config.json
    volumes:
      - ./config.json:/app/config.json
    restart: unless-stopped
    shm_size: '2gb'   # Important: Chromium needs adequate shared memory

networks:
  default:
    name: mcp-network
    external: true
```

Note: `shm_size: '2gb'` is critical — Chromium uses `/dev/shm` for rendering and will crash or tab-crash with Docker's default 64MB.

## Port Assignments

| Port | Service | Notes |
|------|---------|-------|
| 6080 | noVNC | Same port as appium-mcp (only one runs at a time, or remap) |
| 9746 | API + MCP | Avoids conflict with appium-mcp (9745) |
| 5900 | VNC (internal) | Not exposed — websockify connects internally |
