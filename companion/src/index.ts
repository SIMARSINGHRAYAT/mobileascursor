import "dotenv/config";
import express from "express";
import helmet from "helmet";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { createNativeController } from "./native-controller";
import { getIPv4Interfaces, pickDefaultInterface } from "./network";
import { defaultSettings, settingsSchema, socketInboundSchema, type ControllerSettings, type SocketInbound } from "./protocol";
import { SessionManager } from "./session-manager";
import { CloudRelayClient } from "./cloud-relay";

type ManagedSocket = {
  socket: WebSocket;
  id: string;
  approved: boolean;
  deviceLabel?: string;
  settings?: ControllerSettings;
  lastMessageAt: number;
  moveBudgetCount: number;
  moveBudgetWindowStart: number;
};

// Parse command line arguments: --relay <url>, --port <port>
const cliArgs = process.argv.slice(2);
let cliRelayUrl: string | undefined;
let cliPort: number | undefined;
for (let i = 0; i < cliArgs.length; i++) {
  if ((cliArgs[i] === "--relay" || cliArgs[i] === "-r") && cliArgs[i + 1]) {
    cliRelayUrl = cliArgs[i + 1];
  }
  if ((cliArgs[i] === "--port" || cliArgs[i] === "-p") && cliArgs[i + 1]) {
    cliPort = Number(cliArgs[i + 1]);
  }
}

const APP_PORT = cliPort || Number(process.env.COMPANION_PORT ?? 4850);
const WEB_PORT = Number(process.env.APP_WEB_PORT ?? 3000);
let activeRelayUrl: string | null = cliRelayUrl || process.env.APP_WEB_URL || null;

const app = express();
app.use(express.json({ limit: "100kb" }));

// Enable CORS and Private Network Access (PNA) for Vercel, localhost, and remote web dashboards
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, *");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
  }),
);

const manager = new SessionManager();
const native = createNativeController();
const sockets = new Map<string, ManagedSocket>();

const interfaces = getIPv4Interfaces();
let selected = pickDefaultInterface() ?? { name: "loopback", address: "127.0.0.1" };

manager.createToken();

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ─── Cloud Relay Integration ──────────────────────────────────────────────
let cloudRelay: CloudRelayClient | null = null;
let cloudRelayConnected = false;
let cloudMobileDevice: string | null = null;

async function executeCommand(cmd: Exclude<SocketInbound, { type: "pair_request" | "heartbeat" | "disconnect" }>): Promise<void> {
  switch (cmd.type) {
    case "mouse_move":
      await native.move(cmd.dx, cmd.dy);
      break;
    case "left_click":
      await native.leftClick();
      break;
    case "right_click":
      await native.rightClick();
      break;
    case "double_click":
      await native.doubleClick();
      break;
    case "scroll":
      await native.scroll(cmd.deltaY);
      break;
    case "drag_start":
      await native.dragStart();
      break;
    case "drag_end":
      await native.dragEnd();
      break;
    case "zoom_in":
      await native.zoomIn();
      break;
    case "zoom_out":
      await native.zoomOut();
      break;
    case "reset_zoom":
      await native.resetZoom();
      break;
    case "maximize_window":
      await native.maximizeWindow();
      break;
    case "restore_window":
      await native.restoreWindow();
      break;
  }
}

function startCloudRelay(relayUrl: string, token: string) {
  if (cloudRelay) {
    cloudRelay.stop();
  }

  activeRelayUrl = relayUrl;
  console.log(`[companion] Starting cloud relay → ${relayUrl} with token ${token.slice(0, 8)}...`);

  cloudRelay = new CloudRelayClient({
    relayUrl,
    token,
    pollIntervalMs: 60,
    onCommand: async (cmd) => {
      if (cmd.type === "pair_request" || cmd.type === "heartbeat" || cmd.type === "disconnect") {
        return;
      }
      await executeCommand(cmd);
    },
    onMobileConnected: (deviceLabel) => {
      cloudRelayConnected = true;
      cloudMobileDevice = deviceLabel;
      console.log(`[companion] 📱 Mobile connected via Cloud Relay: ${deviceLabel}`);
    },
    onMobileDisconnected: () => {
      cloudRelayConnected = false;
      cloudMobileDevice = null;
      console.log("[companion] Mobile disconnected from Cloud Relay");
    },
    onError: (err) => {
      cloudRelayConnected = false;
      cloudMobileDevice = null;
      console.error("[companion] Cloud relay notice:", err.message);
      // Auto-restart after 5 seconds if we have an active relay url
      setTimeout(() => {
        const currentToken = manager.currentToken();
        if (currentToken && activeRelayUrl) {
          void startCloudRelay(activeRelayUrl, currentToken.value);
        }
      }, 5000);
    },
  });

  void cloudRelay.start();
}

// ─── Pairing URL generation ────────────────────────────────────────────────

function makePairingUrl(token: string, mode: "direct" | "cloud" | "lan_web" = "direct"): string {
  if (mode === "cloud" && activeRelayUrl) {
    const base = activeRelayUrl.replace(/\/$/, "");
    return `${base}/remote?token=${encodeURIComponent(token)}&mode=cloud`;
  }

  if (mode === "lan_web") {
    return `http://${selected.address}:${WEB_PORT}/remote?token=${encodeURIComponent(token)}&wsHost=${encodeURIComponent(selected.address)}&wsPort=${APP_PORT}`;
  }

  // Direct mode: connect straight to companion's HTTP server and inline remote page
  return `http://${selected.address}:${APP_PORT}/remote?token=${encodeURIComponent(token)}`;
}

// Serve standalone zero-dependency mobile touch remote directly from companion over local Wi-Fi
app.get(["/remote", "/"], (req, res) => {
  const token = req.query.token || "";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Mobile as Cursor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
    body { background: #05070d; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; padding: 12px; touch-action: none; }
    header { display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; padding: 10px 16px; margin-bottom: 10px; }
    #status { font-size: 13px; color: #38bdf8; font-weight: 500; display: flex; align-items: center; gap: 6px; }
    #pad { flex: 1; min-height: 40vh; background: radial-gradient(circle at 50% 50%, rgba(56,189,248,0.12) 0%, rgba(15,23,42,0.7) 100%); border: 1.5px solid rgba(56,189,248,0.3); border-radius: 24px; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.5); font-size: 14px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 600; box-shadow: inset 0 0 40px rgba(56,189,248,0.08); }
    .btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
    .btn-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 8px; }
    button { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #fff; border-radius: 16px; padding: 14px 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.1s; }
    button:active { background: rgba(56,189,248,0.35); transform: scale(0.97); }
    .btn-action { padding: 9px 4px; font-size: 12px; font-weight: 500; border-radius: 12px; }
    .badge { width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; }
  </style>
</head>
<body>
  <header>
    <div>
      <div style="font-weight:700;font-size:15px;background:linear-gradient(90deg,#a78bfa,#38bdf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">Mobile as Cursor</div>
      <div id="status"><span class="badge" id="badge"></span><span id="statustext">Connecting...</span></div>
    </div>
    <div style="font-size:11px;color:#94a3b8;border:1px solid rgba(255,255,255,0.15);padding:3px 8px;border-radius:12px;">Local Wi-Fi</div>
  </header>
  <div id="pad">Touch &amp; Drag Cursor</div>
  <div class="btn-row">
    <button id="btn-left" style="background:rgba(56,189,248,0.15);border-color:rgba(56,189,248,0.3);color:#e0f2fe;">Left Click</button>
    <button id="btn-right" style="background:rgba(168,85,247,0.15);border-color:rgba(168,85,247,0.3);color:#f3e8ff;">Right Click</button>
  </div>
  <div class="btn-actions">
    <button class="btn-action" id="btn-max">⛶ Max</button>
    <button class="btn-action" id="btn-rst">🗗 Restore</button>
    <button class="btn-action" id="btn-zin">＋ Zoom</button>
    <button class="btn-action" id="btn-zout">－ Zoom</button>
  </div>
  <script>
    const token = ${JSON.stringify(token)};
    const statustext = document.getElementById('statustext');
    const badge = document.getElementById('badge');
    const pad = document.getElementById('pad');

    let ws;
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + location.host + '/ws');
      ws.onopen = () => {
        statustext.textContent = 'Authenticating...';
        ws.send(JSON.stringify({
          type: 'pair_request',
          token: token,
          deviceLabel: 'Smartphone (' + (navigator.platform || 'Mobile') + ')',
          settings: { sensitivity: 1.5, acceleration: 1.3, smoothing: 0.05 }
        }));
      };
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.type === 'approved') {
            statustext.textContent = 'Connected & Active';
            badge.style.background = '#34d399';
            pad.style.borderColor = '#34d399';
          } else if (d.type === 'waiting') {
            statustext.textContent = 'Awaiting Approval';
            badge.style.background = '#fbbf24';
          } else if (d.type === 'rejected') {
            statustext.textContent = d.reason || 'Pairing Rejected';
            badge.style.background = '#f87171';
          }
        } catch(err){}
      };
      ws.onerror = () => {
        statustext.textContent = 'Connection Error';
        badge.style.background = '#f87171';
      };
      ws.onclose = () => {
        statustext.textContent = 'Reconnecting in 2s...';
        badge.style.background = '#94a3b8';
        setTimeout(connect, 2000);
      };
    }
    connect();

    function send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    }
    setInterval(() => send({ type: 'heartbeat' }), 2000);

    let lastX = 0, lastY = 0, touching = false, startT = 0;
    pad.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        touching = true;
        startT = Date.now();
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
      }
    }, { passive: false });

    pad.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (!touching || e.touches.length !== 1) return;
      const dx = (e.touches[0].clientX - lastX) * 1.5;
      const dy = (e.touches[0].clientY - lastY) * 1.5;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
      send({ type: 'mouse_move', dx, dy });
    }, { passive: false });

    pad.addEventListener('touchend', (e) => {
      if (touching && Date.now() - startT < 220) {
        send({ type: 'left_click' });
        if (navigator.vibrate) navigator.vibrate(8);
      }
      touching = false;
    });

    document.getElementById('btn-left').onclick = () => { send({ type: 'left_click' }); if(navigator.vibrate) navigator.vibrate(10); };
    document.getElementById('btn-right').onclick = () => { send({ type: 'right_click' }); if(navigator.vibrate) navigator.vibrate(10); };
    document.getElementById('btn-max').onclick = () => send({ type: 'maximize_window' });
    document.getElementById('btn-rst').onclick = () => send({ type: 'restore_window' });
    document.getElementById('btn-zin').onclick = () => send({ type: 'zoom_in' });
    document.getElementById('btn-zout').onclick = () => send({ type: 'zoom_out' });
  </script>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

function statusPayload(message?: string) {
  const token = manager.currentToken();
  const active = manager.getActive();
  const pending = manager.getPending();

  // Include cloud device info if no local device is connected
  const connectedDevice = active
    ? { deviceLabel: active.deviceLabel, connectedAt: active.connectedAt }
    : cloudRelayConnected && cloudMobileDevice
      ? { deviceLabel: `${cloudMobileDevice} (Cloud)`, connectedAt: Date.now() }
      : null;

  const effectiveStatus = active
    ? manager.getStatus()
    : cloudRelayConnected
      ? ("Connected" as const)
      : manager.getStatus();

  return {
    status: effectiveStatus,
    hostIp: selected.address,
    webPort: WEB_PORT,
    wsPort: APP_PORT,
    networkName: selected.name,
    pairingUrl: token ? makePairingUrl(token.value) : null,
    cloudPairingUrl: token && activeRelayUrl ? makePairingUrl(token.value, "cloud") : null,
    tokenExpiresAt: token?.expiresAt ?? null,
    pendingRequest: pending,
    connectedDevice,
    latencyMs: active ? Math.max(1, Math.floor(Date.now() - active.lastHeartbeat)) : null,
    controlsEnabled: Boolean(active) || cloudRelayConnected,
    settings: sockets.get(active?.socketId ?? "")?.settings ?? defaultSettings,
    cloudRelayActive: cloudRelay?.isRunning() ?? false,
    activeRelayUrl,
    cloudMobileConnected: cloudRelayConnected,
    message,
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, platform: process.platform, cloudRelayActive: cloudRelay?.isRunning() ?? false });
});

app.get("/api/status", (_req, res) => {
  res.json(statusPayload());
});

app.post("/api/pairing/new", (req, res) => {
  const parsed = z
    .object({
      token: z.string().optional(),
      ttlMinutes: z.number().optional(),
      relayUrl: z.string().optional(),
    })
    .safeParse(req.body);

  const ttlMs = parsed.success && parsed.data.ttlMinutes ? parsed.data.ttlMinutes * 60_000 : 15 * 60_000;
  const customToken = parsed.success ? parsed.data.token : undefined;
  const token = manager.createToken(ttlMs, customToken);

  const relayUrl = (parsed.success && parsed.data.relayUrl) || activeRelayUrl;
  if (relayUrl) {
    activeRelayUrl = relayUrl;
    startCloudRelay(relayUrl, token.token);
  }

  res.json({
    ok: true,
    ...statusPayload(`New token created, valid until ${new Date(token.expiresAt).toLocaleTimeString()}`),
  });
});

app.post("/api/pairing/approve", (req, res) => {
  const parsed = z.object({ requestId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request" });

  const active = manager.approve(parsed.data.requestId);
  if (!active) return res.status(404).json({ ok: false, error: "request_not_found" });

  sockets.forEach((client) => {
    if (client.id === active.socketId) {
      client.approved = true;
      client.socket.send(JSON.stringify({ type: "approved" }));
    }
  });

  res.json({ ok: true, ...statusPayload("Mobile controller approved.") });
});

app.post("/api/pairing/reject", (req, res) => {
  const parsed = z.object({ requestId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request" });

  const rejected = manager.reject(parsed.data.requestId);
  if (!rejected) return res.status(404).json({ ok: false, error: "request_not_found" });

  const target = sockets.get(rejected.socketId);
  target?.socket.send(JSON.stringify({ type: "rejected", reason: "Pairing was rejected from desktop." }));

  res.json({ ok: true, ...statusPayload("Pairing request rejected.") });
});

app.post("/api/disconnect", async (_req, res) => {
  const active = manager.disconnect();
  if (active) {
    sockets.get(active.socketId)?.socket.send(JSON.stringify({ type: "disconnected", reason: "Disconnected by desktop." }));
  }
  await native.releaseAllButtons();
  res.json({ ok: true, ...statusPayload("Device disconnected.") });
});

app.get("/api/interfaces", (_req, res) => {
  const currentInterfaces = getIPv4Interfaces();
  res.json({ selected, interfaces: currentInterfaces });
});

app.post("/api/interface/select", (req, res) => {
  const parsed = z.object({ address: z.string(), name: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request" });

  const currentInterfaces = getIPv4Interfaces();
  const match = currentInterfaces.find((x) => x.address === parsed.data.address);
  if (match) {
    selected = match;
  } else {
    selected = { name: parsed.data.name || "Custom", address: parsed.data.address };
  }
  manager.createToken();
  res.json({ ok: true, selected, ...statusPayload("Network interface updated.") });
});

// Cloud relay management API
app.post("/api/cloud-relay/start", (req, res) => {
  const parsed = z
    .object({
      relayUrl: z.string().optional(),
      token: z.string().optional(),
    })
    .safeParse(req.body);

  const relayUrl = (parsed.success && parsed.data.relayUrl) || activeRelayUrl;
  if (!relayUrl) {
    return res.status(400).json({
      ok: false,
      error: "No relay URL provided. Pass relayUrl or set APP_WEB_URL.",
    });
  }

  activeRelayUrl = relayUrl;
  const token = (parsed.success && parsed.data.token) || manager.currentToken()?.value;
  if (!token) {
    const created = manager.createToken();
    startCloudRelay(relayUrl, created.token);
  } else {
    startCloudRelay(relayUrl, token);
  }

  res.json({
    ok: true,
    ...statusPayload(`Cloud relay active for ${relayUrl}`),
  });
});

app.post("/api/cloud-relay/stop", (_req, res) => {
  if (cloudRelay) {
    cloudRelay.stop();
    cloudRelay = null;
    cloudRelayConnected = false;
    cloudMobileDevice = null;
  }
  res.json({ ok: true, ...statusPayload("Cloud relay stopped") });
});

app.post("/api/settings", (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_settings" });

  const active = manager.getActive();
  if (active) {
    const managed = sockets.get(active.socketId);
    if (managed) {
      managed.settings = parsed.data;
      managed.socket.send(JSON.stringify({ type: "settings_updated", settings: parsed.data }));
    }
  }

  res.json({ ok: true, settings: parsed.data });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "", `http://${request.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (socket) => {
  const id = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const managed: ManagedSocket = {
    socket,
    id,
    approved: false,
    lastMessageAt: Date.now(),
    moveBudgetCount: 0,
    moveBudgetWindowStart: Date.now(),
  };

  sockets.set(id, managed);

  socket.on("message", async (data) => {
    managed.lastMessageAt = Date.now();

    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      return;
    }

    const parsedCandidate = socketInboundSchema.safeParse(json);
    if (!parsedCandidate.success) {
      return;
    }

    const parsed = parsedCandidate.data;

    if (parsed.type === "heartbeat") {
      manager.touchHeartbeat(id);
      socket.send(JSON.stringify({ type: "ack" }));
      return;
    }

    if (parsed.type === "disconnect") {
      const active = manager.disconnect(id);
      if (active) {
        await native.releaseAllButtons();
      }
      sockets.delete(id);
      socket.close();
      return;
    }

    if (parsed.type === "pair_request") {
      managed.deviceLabel = parsed.deviceLabel;
      managed.settings = parsed.settings;

      const result = manager.receivePairRequest({
        token: parsed.token,
        deviceLabel: parsed.deviceLabel,
        socketId: id,
      });

      if (!result.ok) {
        socket.send(JSON.stringify({ type: "rejected", reason: result.reason ?? "Rejected" }));
        return;
      }

      socket.send(JSON.stringify({ type: "waiting" }));
      return;
    }

    if (!managed.approved) {
      return;
    }

    if (parsed.type === "mouse_move") {
      const now = Date.now();
      if (now - managed.moveBudgetWindowStart > 1000) {
        managed.moveBudgetWindowStart = now;
        managed.moveBudgetCount = 0;
      }
      managed.moveBudgetCount += 1;
      if (managed.moveBudgetCount > 300) {
        return;
      }
    }

    await executeCommand(parsed);
  });

  socket.on("close", async () => {
    const active = manager.disconnect(id);
    if (active) {
      await native.releaseAllButtons();
    }
    sockets.delete(id);
  });
});

setInterval(async () => {
  if (manager.heartbeatTimedOut()) {
    const active = manager.getActive();
    if (active) {
      sockets.get(active.socketId)?.socket.send(JSON.stringify({ type: "disconnected", reason: "Heartbeat timeout" }));
      manager.disconnect(active.socketId);
      await native.releaseAllButtons();
    }
  }
}, 2000).unref();

server.listen(APP_PORT, "0.0.0.0", () => {
  console.log(`\n======================================================`);
  console.log(`  🚀 Mobile as Cursor Companion Server running!`);
  console.log(`======================================================`);
  console.log(`[companion] Local Port       : ${APP_PORT}`);
  console.log(`[companion] Local IP         : ${selected.address}`);
  console.log(`[companion] Local Direct URL : http://${selected.address}:${APP_PORT}/remote`);
  
  if (activeRelayUrl) {
    console.log(`[companion] ☁️  Cloud Relay    : ${activeRelayUrl}`);
    const token = manager.currentToken();
    if (token) {
      startCloudRelay(activeRelayUrl, token.value);
      console.log(`[companion] 📱 Cloud Remote   : ${makePairingUrl(token.value, "cloud")}`);
    }
  } else {
    console.log(`[companion] ☁️  Cloud Relay    : Inactive`);
    console.log(`[companion]    To enable cross-network mobile control (any Wi-Fi / 4G / 5G):`);
    console.log(`[companion]    Set APP_WEB_URL=https://your-app.vercel.app in .env or`);
    console.log(`[companion]    Run with: npm run companion:dev -- --relay https://your-app.vercel.app`);
    console.log(`[companion]    Or connect it with one click from the web dashboard!`);
  }

  if (process.platform !== "win32") {
    console.warn("[companion] Native mouse injection is active only on Windows in this build.");
  }
  console.log(`======================================================\n`);
});
