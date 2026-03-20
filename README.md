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
| `GET` | `/api/status` | Browser health, current URL, viewport info |
| `POST` | `/api/navigate` | Navigate to a URL |
| `POST` | `/api/action` | Perform click, type, scroll actions |
| `GET` | `/api/screenshot` | Capture current page screenshot |
| `POST` | `/api/evaluate` | Execute JavaScript in page context |
| `GET` | `/api/console` | Retrieve console log entries |
| `GET` | `/api/cookies` | Get cookies for current page |
| `POST` | `/api/cookies` | Set cookies |
| `DELETE` | `/api/cookies` | Clear cookies |

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

## Configuration

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

## Network

Connects to the shared `mcp-network` Docker network for integration with other MCP services (mcp-aggregator, appium-mcp, etc.).
