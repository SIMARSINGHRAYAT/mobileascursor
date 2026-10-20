import express from "express";
import helmet from "helmet";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { createNativeController } from "./native-controller";
import { getIPv4Interfaces, pickDefaultInterface } from "./network";
import { defaultSettings, settingsSchema, socketInboundSchema, type ControllerSettings, type SocketInbound } from "./protocol";
import { SessionManager } from "./session-manager";

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

const APP_PORT = Number(process.env.COMPANION_PORT ?? 4850);
const WEB_PORT = Number(process.env.APP_WEB_PORT ?? 3000);

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(
  helmet({
    contentSecurityPolicy: false,
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

function makePairingUrl(token: string): string {
  return `http://${selected.address}:${WEB_PORT}/remote?token=${encodeURIComponent(token)}&wsPort=${APP_PORT}`;
}

function statusPayload(message?: string) {
  const token = manager.currentToken();
  const active = manager.getActive();
  const pending = manager.getPending();
  return {
    status: manager.getStatus(),
    hostIp: selected.address,
    webPort: WEB_PORT,
    wsPort: APP_PORT,
    networkName: selected.name,
    pairingUrl: token ? makePairingUrl(token.value) : null,
    tokenExpiresAt: token?.expiresAt ?? null,
    pendingRequest: pending,
    connectedDevice: active ? { deviceLabel: active.deviceLabel, connectedAt: active.connectedAt } : null,
    latencyMs: active ? Math.max(1, Math.floor(Date.now() - active.lastHeartbeat)) : null,
    controlsEnabled: Boolean(active),
    settings: sockets.get(active?.socketId ?? "")?.settings ?? defaultSettings,
    message,
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, platform: process.platform });
});

app.get("/api/status", (_req, res) => {
  res.json(statusPayload());
});

app.post("/api/pairing/new", (_req, res) => {
  const token = manager.createToken();
  res.json({ ok: true, ...statusPayload(`New token created, valid until ${new Date(token.expiresAt).toLocaleTimeString()}`) });
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
  res.json({ selected, interfaces });
});

app.post("/api/interface/select", (req, res) => {
  const parsed = z.object({ address: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request" });

  const match = interfaces.find((x) => x.address === parsed.data.address);
  if (!match) return res.status(404).json({ ok: false, error: "interface_not_found" });

  selected = match;
  manager.createToken();
  res.json({ ok: true, selected, ...statusPayload("Network interface updated.") });
});

app.post("/api/settings", (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_settings" });

  const active = manager.getActive();
  if (active) {
    const client = sockets.get(active.socketId);
    if (client) client.settings = parsed.data;
  }

  res.json({ ok: true });
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws);
  });
});

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

function socketId() {
  return Math.random().toString(36).slice(2);
}

wss.on("connection", (socket) => {
  const id = socketId();
  const managed: ManagedSocket = {
    socket,
    id,
    approved: false,
    settings: defaultSettings,
    lastMessageAt: Date.now(),
    moveBudgetCount: 0,
    moveBudgetWindowStart: Date.now(),
  };
  sockets.set(id, managed);

  socket.on("message", async (raw) => {
    managed.lastMessageAt = Date.now();
    let parsed: SocketInbound;
    try {
      parsed = socketInboundSchema.parse(JSON.parse(String(raw)));
    } catch {
      socket.send(JSON.stringify({ type: "rejected", reason: "Invalid command payload" }));
      return;
    }

    if (parsed.type === "pair_request") {
      const result = manager.receivePairRequest({ token: parsed.token, deviceLabel: parsed.deviceLabel, socketId: id });
      if (!result.ok) {
        socket.send(JSON.stringify({ type: "rejected", reason: result.reason }));
        return;
      }
      managed.deviceLabel = parsed.deviceLabel;
      managed.settings = parsed.settings ?? defaultSettings;
      socket.send(JSON.stringify({ type: "waiting" }));
      return;
    }

    if (parsed.type === "heartbeat") {
      manager.touchHeartbeat(id);
      return;
    }

    if (parsed.type === "disconnect") {
      manager.disconnect(id);
      await native.releaseAllButtons();
      socket.send(JSON.stringify({ type: "disconnected", reason: "Disconnected from mobile." }));
      return;
    }

    if (!manager.isAuthorizedSocket(id)) {
      socket.send(JSON.stringify({ type: "rejected", reason: "Unauthorized session." }));
      return;
    }

    if (parsed.type === "mouse_move") {
      const now = Date.now();
      if (now - managed.moveBudgetWindowStart > 1000) {
        managed.moveBudgetWindowStart = now;
        managed.moveBudgetCount = 0;
      }
      managed.moveBudgetCount += 1;
      if (managed.moveBudgetCount > 120) {
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
  console.log(`[companion] Mobile as Cursor companion listening on :${APP_PORT}`);
  console.log(`[companion] Pairing URL base IP ${selected.address}, web port ${WEB_PORT}`);
  if (process.platform !== "win32") {
    console.warn("[companion] Native mouse injection is active only on Windows in this build.");
  }
});
