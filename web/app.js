// Status polling
async function loadStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();

    // Drawer badge
    const browserEl = document.getElementById("browser-status");
    if (data.running) {
      browserEl.textContent = "running";
      browserEl.className = "status-badge badge-green";
    } else {
      browserEl.textContent = "stopped";
      browserEl.className = "status-badge badge-red";
    }

    // Floating pill
    const browserPill = document.getElementById("browser-pill");
    browserPill.textContent = data.running ? "Browser: running" : "Browser: stopped";
    browserPill.className = "status-pill " + (data.running ? "pill-green" : "pill-red");

    // Page info
    const urlEl = document.getElementById("page-url");
    urlEl.textContent = data.url ? "URL: " + data.url : "";

    const titleEl = document.getElementById("page-title");
    titleEl.textContent = data.title ? "Title: " + data.title : "";
  } catch {
    // ignore polling errors
  }
}

// Config management
async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();

    document.getElementById("cfg-default-url").value = cfg.browser.defaultUrl;
    document.getElementById("cfg-port").value = cfg.port;
    document.getElementById("cfg-vp-width").value = cfg.browser.viewport.width;
    document.getElementById("cfg-vp-height").value = cfg.browser.viewport.height;
    document.getElementById("cfg-vnc-res").value = cfg.vnc.resolution;
  } catch (err) {
    console.error("Failed to load config:", err);
  }
}

async function saveConfig() {
  const body = {
    port: parseInt(document.getElementById("cfg-port").value, 10),
    browser: {
      defaultUrl: document.getElementById("cfg-default-url").value,
      viewport: {
        width: parseInt(document.getElementById("cfg-vp-width").value, 10),
        height: parseInt(document.getElementById("cfg-vp-height").value, 10),
      },
    },
    vnc: {
      resolution: document.getElementById("cfg-vnc-res").value,
    },
  };

  try {
    const res = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      alert("Config saved");
    } else {
      const err = await res.json();
      alert("Error: " + JSON.stringify(err));
    }
  } catch (err) {
    alert("Failed to save config: " + err);
  }
}

// Browser actions
async function navigateTo() {
  const url = document.getElementById("nav-url").value;
  if (!url) return;
  try {
    const res = await fetch("/api/navigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (res.ok) {
      loadStatus();
    } else {
      alert("Error: " + (data.error || JSON.stringify(data)));
    }
  } catch (err) {
    alert("Failed to navigate: " + err);
  }
}

async function takeScreenshot() {
  try {
    const res = await fetch("/api/screenshot");
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
    } else {
      alert("Failed to take screenshot");
    }
  } catch (err) {
    alert("Screenshot error: " + err);
  }
}

async function reloadPage() {
  try {
    await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: "location.reload()" }),
    });
    loadStatus();
  } catch (err) {
    alert("Reload error: " + err);
  }
}

// MCP info
async function loadMcpInfo() {
  try {
    const res = await fetch("/api/mcp-server-info");
    const data = await res.json();
    const el = document.getElementById("mcp-info");
    el.innerHTML = `
      <p class="info-text">Endpoint: <code>${data.httpUrl}</code></p>
      <p class="info-text" style="margin-top:4px;">${data.tools.length} tools available</p>
      <p class="info-text" style="margin-top:8px;">Claude Desktop config:</p>
      <pre>${JSON.stringify(data.claudeConfig, null, 2)}</pre>
    `;
  } catch {
    // ignore
  }
}

// noVNC embed with auto-scaling
function initVnc() {
  const vncFrame = document.getElementById("vnc-frame");
  const vncHost = window.location.hostname;
  vncFrame.src = `http://${vncHost}:6080/vnc.html?resize=scale&scaleViewport=true&autoconnect=true&reconnect=true&reconnect_delay=1000`;
}

// Drawer toggle
function toggleDrawer() {
  document.getElementById("drawer").classList.toggle("open");
}

// Handle Enter key on URL input
document.getElementById("nav-url").addEventListener("keydown", function (e) {
  if (e.key === "Enter") navigateTo();
});

// Init
loadStatus();
loadConfig();
loadMcpInfo();
initVnc();
setInterval(loadStatus, 5000);
