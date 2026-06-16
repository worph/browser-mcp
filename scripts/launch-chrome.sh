#!/usr/bin/env bash
# Launch the single shared Chrome on display :99 with CDP remote debugging.
# Both chrome-devtools-mcp (MCP surface) and Playwright (REST/web-UI surface)
# attach to this instance, and noVNC mirrors it.
set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
WINDOW_SIZE="${WINDOW_SIZE:-1280,720}"
START_URL="${BROWSER_DEFAULT_URL:-about:blank}"

# Resolve the Chromium binary: explicit override, else the Playwright-installed one.
if [ -n "${CHROME_EXECUTABLE_PATH:-}" ]; then
  CHROME="${CHROME_EXECUTABLE_PATH}"
else
  CHROME="$(node -e "console.log(require('playwright-core').chromium.executablePath())")"
fi

echo "Launching Chrome: ${CHROME} (CDP :${CDP_PORT}, display ${DISPLAY:-unset})"

exec "${CHROME}" \
  --remote-debugging-port="${CDP_PORT}" \
  --user-data-dir=/tmp/chrome-profile \
  --window-size="${WINDOW_SIZE}" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-software-rasterizer \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate \
  "${START_URL}"
