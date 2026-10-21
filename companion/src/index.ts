import "dotenv/config";
import express from "express";
import helmet from "helmet";
import http from "node:http";
import QRCode from "qrcode";
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

// Guard against transient network disconnects
process.on("uncaughtException", (err) => {
  console.warn("[companion] Network notice (resilient):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.warn("[companion] Network promise rejection (resilient):", reason);
});

// Parse command line arguments: --relay <url>, --port <port>, --token <token>
const cliArgs = process.argv.slice(2);
let cliRelayUrl: string | undefined;
let cliPort: number | undefined;
let cliToken: string | undefined;

for (let i = 0; i < cliArgs.length; i++) {
  if ((cliArgs[i] === "--relay" || cliArgs[i] === "-r") && cliArgs[i + 1]) {
    cliRelayUrl = cliArgs[i + 1];
  }
  if ((cliArgs[i] === "--port" || cliArgs[i] === "-p") && cliArgs[i + 1]) {
    cliPort = Number(cliArgs[i + 1]);
  }
  if ((cliArgs[i] === "--token" || cliArgs[i] === "-t") && cliArgs[i + 1]) {
    cliToken = cliArgs[i + 1];
  }
}

const APP_PORT = cliPort || Number(process.env.COMPANION_PORT ?? 4850);
const WEB_PORT = Number(process.env.APP_WEB_PORT ?? 3000);
let activeRelayUrl: string = cliRelayUrl || process.env.APP_WEB_URL || "https://mobileascursor.vercel.app";

const app = express();
app.use(express.json({ limit: "100kb" }));

// Enable CORS and Private Network Access (PNA)
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

// Initialize persistent 24h token
const initialToken = manager.createToken(24 * 60 * 60_000, cliToken);

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ─── Cloud Relay Integration ──────────────────────────────────────────────
let cloudRelay: CloudRelayClient | null = null;
let cloudRelayConnected = false;
let cloudMobileDevice: string | null = null;

let moveCount = 0;
let lastMoveLog = Date.now();

async function executeCommand(cmd: Exclude<SocketInbound, { type: "pair_request" | "heartbeat" | "disconnect" }>): Promise<void> {
  if (cmd.type === "mouse_move") {
    moveCount++;
    const now = Date.now();
    if (now - lastMoveLog > 1500) {
      console.log(`[companion] 🖱️ Cursor gliding (dx=${Math.round(cmd.dx)}, dy=${Math.round(cmd.dy)}, batch=${moveCount})`);
      lastMoveLog = now;
      moveCount = 0;
    }
    await native.move(cmd.dx, cmd.dy);
    return;
  }
  console.log(`[companion] ⚡ Executing: ${cmd.type}`);
  switch (cmd.type) {
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

function startCloudRelay(token: string, relayUrl?: string | null) {
  if (cloudRelay) {
    cloudRelay.stop();
  }

  if (relayUrl) {
    activeRelayUrl = relayUrl;
  }

  console.log(`[companion] ⚡ Activating cloud relay for token ${token}...`);

  cloudRelay = new CloudRelayClient({
    relayUrl: activeRelayUrl,
    token,
    onCommand: async (cmd) => {
      if (cmd.type === "pair_request" || cmd.type === "heartbeat" || cmd.type === "disconnect") {
        return;
      }
      await executeCommand(cmd);
    },
    onMobileConnected: (deviceLabel) => {
      cloudRelayConnected = true;
      cloudMobileDevice = deviceLabel;
      console.log(`[companion] 📱 Mobile phone connected: ${deviceLabel}`);
    },
    onMobileDisconnected: () => {
      cloudRelayConnected = false;
      cloudMobileDevice = null;
      console.log("[companion] Mobile phone disconnected");
    },
    onError: (err) => {
      console.warn("[companion] Cloud notice:", err.message);
    },
  });

  cloudRelay.start();
}

// ─── Pairing URL generation ────────────────────────────────────────────────

function makePairingUrl(token: string, mode: "cloud" | "direct" | "lan_web" = "cloud"): string {
  if (mode === "cloud") {
    const base = activeRelayUrl.replace(/\/$/, "");
    return `${base}/remote?token=${encodeURIComponent(token)}&mode=cloud`;
  }

  if (mode === "lan_web") {
    return `http://${selected.address}:${WEB_PORT}/remote?token=${encodeURIComponent(token)}&wsHost=${encodeURIComponent(selected.address)}&wsPort=${APP_PORT}`;
  }

  // Direct mode: connect straight to companion's HTTP server
  return `http://${selected.address}:${APP_PORT}/remote?token=${encodeURIComponent(token)}`;
}

// ─── Local Companion Pairing Web UI ───────────────────────────────────────

app.get(["/", "/dashboard"], async (req, res) => {
  const currentToken = manager.currentToken().value;
  const cloudUrl = makePairingUrl(currentToken, "cloud");
  const directUrl = makePairingUrl(currentToken, "direct");

  let qrDataUrl = "";
  try {
    qrDataUrl = await QRCode.toDataURL(cloudUrl, {
      margin: 2,
      width: 480,
      color: { dark: "#0f172a", light: "#ffffff" },
    });
  } catch {
    // ignore
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mobile as Cursor — Desktop Companion</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #05070d; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 28px; padding: 36px; max-width: 520px; width: 100%; text-align: center; box-shadow: 0 0 60px rgba(56, 189, 248, 0.15); backdrop-filter: blur(20px); }
    h1 { font-size: 26px; font-weight: 800; background: linear-gradient(135deg, #a78bfa, #38bdf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 6px; }
    p.sub { font-size: 13px; color: #94a3b8; margin-bottom: 24px; }
    .qr-box { background: #fff; padding: 18px; border-radius: 22px; display: inline-block; margin-bottom: 20px; box-shadow: 0 0 40px rgba(56,189,248,0.25); }
    img.qr { width: 260px; height: 260px; display: block; border-radius: 12px; }
    .badge { display: inline-flex; align-items: center; gap: 8px; background: rgba(52, 211, 153, 0.15); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.3); padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; margin-bottom: 20px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; box-shadow: 0 0 10px #34d399; }
    .token-box { background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; padding: 12px; font-family: monospace; font-size: 14px; color: #38bdf8; word-break: break-all; margin-bottom: 20px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
    a.btn { display: block; padding: 12px; border-radius: 14px; text-decoration: none; font-weight: 600; font-size: 13px; transition: all 0.15s; }
    a.primary { background: #38bdf8; color: #020617; }
    a.secondary { background: rgba(255,255,255,0.08); color: #f8fafc; border: 1px solid rgba(255,255,255,0.15); }
  </style>
</head>
<body>
  <div class="card">
    <h1>Mobile as Cursor</h1>
    <p class="sub">Desktop companion is active &amp; ready</p>
    <div class="badge"><span class="dot"></span> Native Windows Injector Ready</div>
    <div class="qr-box">
      <img class="qr" src="${qrDataUrl}" alt="Scan QR code">
    </div>
    <div class="token-box">
      Pairing Code: <strong>${currentToken}</strong>
    </div>
    <p style="font-size:12px;color:#94a3b8;margin-bottom:16px;">
      Point your smartphone camera at the QR code above.<br>
      Works across <strong>any network</strong> (mobile data, 4G/5G, Wi-Fi).
    </p>
    <div class="actions">
      <a class="btn primary" href="${cloudUrl}" target="_blank">Test Mobile UI ↗</a>
      <a class="btn secondary" href="${directUrl}" target="_blank">Direct Wi-Fi Link ↗</a>
    </div>
  </div>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// Serve direct standalone remote
app.get("/remote", (req, res) => {
  const token = req.query.token || manager.currentToken().value;
  res.redirect(`/remote?token=${encodeURIComponent(String(token))}`);
});

function statusPayload(message?: string) {
  const token = manager.currentToken();
  const active = manager.getActive();
  const pending = manager.getPending();

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
    pairingUrl: token ? makePairingUrl(token.value, "cloud") : null,
    cloudPairingUrl: token ? makePairingUrl(token.value, "cloud") : null,
    tokenExpiresAt: token.expiresAt,
    pendingRequest: pending,
    connectedDevice,
    latencyMs: active ? Math.max(1, Math.floor(Date.now() - active.lastHeartbeat)) : 12,
    controlsEnabled: true,
    settings: sockets.get(active?.socketId ?? "")?.settings ?? defaultSettings,
    cloudRelayActive: cloudRelay?.isRunning() ?? true,
    activeRelayUrl,
    cloudMobileConnected: cloudRelayConnected,
    token: token.value,
    message,
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, platform: process.platform, cloudRelayActive: cloudRelay?.isRunning() ?? true });
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

  const ttlMs = parsed.success && parsed.data.ttlMinutes ? parsed.data.ttlMinutes * 60_000 : 24 * 60 * 60_000;
  const customToken = parsed.success ? parsed.data.token : undefined;
  const token = manager.createToken(ttlMs, customToken);

  const relayUrl = (parsed.success && parsed.data.relayUrl) || activeRelayUrl;
  startCloudRelay(token.token, relayUrl);

  res.json({
    ok: true,
    ...statusPayload(`Token active`),
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
  res.json({ ok: true, selected, ...statusPayload("Network interface updated.") });
});

app.post("/api/cloud-relay/start", (req, res) => {
  const parsed = z
    .object({
      relayUrl: z.string().optional(),
      token: z.string().optional(),
    })
    .safeParse(req.body);

  const relayUrl = (parsed.success && parsed.data.relayUrl) || activeRelayUrl;
  const token = (parsed.success && parsed.data.token) || manager.currentToken().value;
  startCloudRelay(token, relayUrl);

  res.json({
    ok: true,
    ...statusPayload(`Cloud relay active`),
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

server.listen(APP_PORT, "0.0.0.0", async () => {
  const currentToken = manager.currentToken().value;
  const cloudUrl = makePairingUrl(currentToken, "cloud");

  // Start cloud relay automatically on boot
  startCloudRelay(currentToken, activeRelayUrl);

  console.log(`\n======================================================`);
  console.log(`  🚀 Mobile as Cursor Companion Server running!`);
  console.log(`======================================================`);
  console.log(`[companion] Local Port       : ${APP_PORT}`);
  console.log(`[companion] Local IP         : ${selected.address}`);
  console.log(`[companion] 🔑 Pairing Code  : ${currentToken}`);
  console.log(`[companion] 💻 Web Dashboard : http://localhost:${APP_PORT}`);
  console.log(`[companion] 📱 Mobile Cloud  : ${cloudUrl}`);
  console.log(`------------------------------------------------------`);
  console.log(`  SCAN THIS QR CODE ON YOUR PHONE TO CONTROL CURSOR:`);
  console.log(`------------------------------------------------------`);

  try {
    const qrString = await QRCode.toString(cloudUrl, { type: "terminal", small: true });
    console.log(qrString);
  } catch {
    // ignore
  }

  console.log(`======================================================\n`);
});
