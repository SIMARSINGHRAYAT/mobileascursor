"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { defaultSettings, settingsSchema, type ControlMessage, type ControllerSettings } from "@/lib/control-protocol";

type SocketState = "connecting" | "awaiting_approval" | "connected" | "disconnected" | "error";
type ConnectionMode = "websocket" | "cloud";

const storageKey = "mobile-as-cursor:settings";
const hostStorageKey = "mobile-as-cursor:ws-host";

export default function RemotePage() {
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [statusText, setStatusText] = useState("Connecting...");
  const [settings, setSettings] = useState<ControllerSettings>(() => {
    if (typeof window !== "undefined") {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        try {
          return settingsSchema.parse(JSON.parse(raw));
        } catch {
          localStorage.removeItem(storageKey);
        }
      }
    }
    return defaultSettings;
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showHostConfig, setShowHostConfig] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const padRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pendingMoveRef = useRef({ dx: 0, dy: 0 });
  const rafRef = useRef<number | null>(null);
  const lastTapRef = useRef<number>(0);
  const draggingRef = useRef(false);

  // Cloud mode batching
  const cloudBatchRef = useRef<Array<{ type: string; [key: string]: unknown }>>([]);
  const cloudFlushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [token, setToken] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return params.get("token") ?? "";
    }
    return "";
  });

  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return params.get("mode") === "cloud" ? "cloud" : "websocket";
    }
    return "cloud";
  });

  const [wsPort, setWsPort] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return Number(params.get("wsPort") ?? "4850");
    }
    return 4850;
  });

  const [wsHost, setWsHost] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const paramHost = params.get("wsHost") || params.get("host");
      if (paramHost) return paramHost;
      const saved = localStorage.getItem(hostStorageKey);
      if (saved) return saved;
      return window.location.hostname;
    }
    return "";
  });

  const [device] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return params.get("device") || `Phone-${Math.floor(Math.random() * 900 + 100)}`;
    }
    return "Phone";
  });

  const [hostInput, setHostInput] = useState<string>(wsHost);
  const [companionActive, setCompanionActive] = useState(false);

  // ─── Cloud Mode: POST commands to relay API ─────────────────────────

  const cloudRelayUrl = typeof window !== "undefined" ? window.location.origin : "";

  const flushCloudBatch = useCallback(async () => {
    const batch = cloudBatchRef.current;
    if (batch.length === 0) return;
    cloudBatchRef.current = [];

    try {
      await fetch(`${cloudRelayUrl}/api/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "command",
          token,
          commands: batch,
        }),
      });
    } catch {
      // Retried on next batch
    }
  }, [cloudRelayUrl, token]);

  const sendCloud = useCallback(
    (msg: { type: string; [key: string]: unknown }) => {
      cloudBatchRef.current.push(msg);
      // Immediate flush for clicks and discrete actions
      if (msg.type !== "mouse_move" && msg.type !== "heartbeat") {
        void flushCloudBatch();
      }
    },
    [flushCloudBatch],
  );

  // ─── WebSocket Mode ─────────────────────────────────────────────────

  const sendWs = useCallback(
    (msg: ControlMessage | { type: "pair_request"; token: string; deviceLabel: string; settings: ControllerSettings }) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      }
    },
    [],
  );

  const send = useCallback(
    (msg: ControlMessage | { type: "pair_request"; token: string; deviceLabel: string; settings: ControllerSettings }) => {
      if (connectionMode === "cloud") {
        sendCloud(msg as { type: string; [key: string]: unknown });
      } else {
        sendWs(msg);
      }
    },
    [connectionMode, sendCloud, sendWs],
  );

  const flushMove = useCallback(() => {
    rafRef.current = null;
    const dx = pendingMoveRef.current.dx;
    const dy = pendingMoveRef.current.dy;
    pendingMoveRef.current = { dx: 0, dy: 0 };
    if (dx === 0 && dy === 0) return;
    send({ type: "mouse_move", dx, dy });
  }, [send]);

  const queueMove = useCallback(
    (dx: number, dy: number) => {
      pendingMoveRef.current.dx += dx;
      pendingMoveRef.current.dy += dy;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushMove);
      }
    },
    [flushMove],
  );

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(storageKey, JSON.stringify(settings));
    }
  }, [settings]);

  // ─── Cloud Mode: Join session & start batch flushing ────────────────

  useEffect(() => {
    if (connectionMode !== "cloud" || !token) return;

    let alive = true;

    const joinSession = async () => {
      try {
        const res = await fetch(`${cloudRelayUrl}/api/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "join",
            token,
            deviceLabel: device,
          }),
        });

        const data = (await res.json()) as {
          ok: boolean;
          status?: string;
          companionActive?: boolean;
          message?: string;
        };
        if (!alive) return;

        if (data.ok) {
          const isCompActive = Boolean(data.companionActive || data.status === "connected");
          setCompanionActive(isCompActive);
          setSocketState("connected");
          setStatusText(isCompActive ? "Connected to PC" : "Waiting for PC companion...");
        } else {
          setSocketState("error");
          setStatusText("Failed to join relay session");
        }
      } catch {
        if (!alive) return;
        setSocketState("error");
        setStatusText("Cannot reach cloud relay");
      }
    };

    void joinSession();

    // Flush mouse move batches every 40ms for responsive cursor
    const flushTimer = setInterval(() => {
      void flushCloudBatch();
    }, 40);
    cloudFlushTimerRef.current = flushTimer;

    // Check relay status every 1.5 seconds to track companion status
    const statusTimer = setInterval(async () => {
      if (!alive) return;
      try {
        const res = await fetch(`${cloudRelayUrl}/api/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "status",
            token,
          }),
        });

        const data = (await res.json()) as { ok: boolean; companionActive?: boolean };
        if (!alive) return;

        if (data.ok) {
          const isCompActive = Boolean(data.companionActive);
          setCompanionActive(isCompActive);
          setSocketState("connected");
          setStatusText(isCompActive ? "Connected to PC" : "Waiting for PC companion to connect...");
        }
      } catch {
        // Ignore status check errors
      }
    }, 1500);

    // Send heartbeats every 5 seconds
    const heartbeatTimer = setInterval(() => {
      void fetch(`${cloudRelayUrl}/api/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "heartbeat",
          token,
          role: "mobile",
        }),
      }).catch(() => {});
    }, 5000);

    return () => {
      alive = false;
      clearInterval(flushTimer);
      clearInterval(statusTimer);
      clearInterval(heartbeatTimer);
      cloudFlushTimerRef.current = null;
    };
  }, [connectionMode, token, device, cloudRelayUrl, flushCloudBatch]);

  // ─── WebSocket Mode: Connect to companion WebSocket server ──────────

  useEffect(() => {
    if (connectionMode !== "websocket") return;
    if (!token || !device || !wsHost) return;

    let wsUrl: string;
    if (wsHost.startsWith("ws://") || wsHost.startsWith("wss://")) {
      wsUrl = wsHost.endsWith("/ws") ? wsHost : `${wsHost}/ws`;
    } else {
      const protocol = window.location.protocol === "https:" && !wsHost.match(/^\d+\.\d+\.\d+\.\d+$/) ? "wss" : "ws";
      wsUrl = `${protocol}://${wsHost}:${wsPort}/ws`;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      queueMicrotask(() => {
        setSocketState("error");
        setStatusText("Failed to create WebSocket");
      });
      return;
    }

    wsRef.current = socket;

    socket.onopen = () => {
      setSocketState("awaiting_approval");
      setStatusText("Awaiting desktop approval");
      socket.send(
        JSON.stringify({
          type: "pair_request",
          token,
          deviceLabel: device,
          settings,
        }),
      );
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as { type: string; reason?: string };
        if (data.type === "approved") {
          setSocketState("connected");
          setCompanionActive(true);
          setStatusText("Connected to PC");
        } else if (data.type === "waiting") {
          setSocketState("awaiting_approval");
          setStatusText("Awaiting approval");
        } else if (data.type === "rejected") {
          setSocketState("error");
          setStatusText(data.reason ?? "Pairing rejected");
        } else if (data.type === "disconnected") {
          setSocketState("disconnected");
          setCompanionActive(false);
          setStatusText(data.reason ?? "Disconnected");
        }
      } catch {
        setSocketState("error");
        setStatusText("Invalid server message");
      }
    };

    socket.onerror = () => {
      setSocketState("error");
      setCompanionActive(false);
      setStatusText(`Cannot reach ${wsHost}:${wsPort}`);
    };

    socket.onclose = () => {
      setSocketState("disconnected");
      setCompanionActive(false);
      setStatusText("Connection closed");
    };

    const heartbeat = setInterval(() => sendWs({ type: "heartbeat" }), 2000);
    return () => {
      clearInterval(heartbeat);
      socket.close();
      wsRef.current = null;
    };
  }, [connectionMode, device, sendWs, settings, token, wsHost, wsPort]);

  const moveTransform = (dx: number, dy: number) => {
    const speed = settings.sensitivity;
    const magnitude = Math.sqrt(dx * dx + dy * dy);
    const accel = Math.max(1, 1 + (settings.acceleration - 1) * Math.min(1.5, magnitude / 16));
    const sx = dx * speed * accel;
    const sy = dy * speed * accel;
    return {
      dx: sx * (1 - settings.smoothing),
      dy: sy * (1 - settings.smoothing),
    };
  };

  const pointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };

  const pointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointersRef.current.get(e.pointerId);
    if (!prev) return;

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const pointerCount = pointersRef.current.size;
    if (pointerCount >= 2 && settings.twoFingerScroll) {
      send({ type: "scroll", deltaY: (settings.naturalScroll ? -1 : 1) * dy * 1.5 });
      return;
    }

    const transformed = moveTransform(dx, dy);
    queueMove(transformed.dx, transformed.dy);
  };

  const pointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startCount = pointersRef.current.size;
    pointersRef.current.delete(e.pointerId);

    if (startCount === 1 && settings.tapToClick && !draggingRef.current) {
      const now = Date.now();
      if (settings.doubleTap && now - lastTapRef.current < 260) {
        send({ type: "double_click" });
        lastTapRef.current = 0;
      } else {
        send({ type: "left_click" });
        lastTapRef.current = now;
      }
      if (settings.haptic && navigator.vibrate) navigator.vibrate(8);
    }

    if (draggingRef.current && !settings.dragLock) {
      draggingRef.current = false;
      send({ type: "drag_end" });
    }
  };

  const action = (type: ControlMessage["type"]) => {
    send({ type } as ControlMessage);
    if (settings.haptic && navigator.vibrate) navigator.vibrate(10);
  };

  const reconnectWithHost = (newHost: string) => {
    const trimmed = newHost.trim();
    setWsHost(trimmed);
    if (typeof window !== "undefined") {
      localStorage.setItem(hostStorageKey, trimmed);
    }
    setShowHostConfig(false);
  };

  const switchToDirectMode = () => {
    setConnectionMode("websocket");
    setSocketState("connecting");
    setStatusText("Switching to Direct Wi-Fi...");
  };

  const switchToCloudMode = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionMode("cloud");
    setSocketState("connecting");
    setStatusText("Switching to Cloud Relay...");
  };

  const modeLabel = connectionMode === "cloud" ? "☁ Cloud Relay" : "⚡ Direct Wi-Fi";
  const modeBadgeColor =
    connectionMode === "cloud"
      ? "bg-violet-500/30 text-violet-200 border-violet-500/40"
      : "bg-cyan-500/30 text-cyan-200 border-cyan-500/40";

  return (
    <main className="futuristic-bg flex min-h-screen flex-col px-3 pb-4 pt-3 text-white">
      <header className="glass-card gradient-border flex items-center justify-between rounded-2xl px-4 py-3">
        <div>
          <h1 className="text-base font-semibold">Mobile as Cursor</h1>
          <p className="text-xs text-slate-300">
            {statusText} {connectionMode === "websocket" && wsHost ? `(${wsHost})` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <span className={`rounded-lg px-2.5 py-1.5 text-[10px] font-semibold border ${modeBadgeColor}`}>
            {modeLabel}
          </span>
          <button
            className="rounded-lg bg-white/10 px-2.5 py-1.5 text-xs text-cyan-200"
            onClick={() => {
              setHostInput(wsHost);
              setShowHostConfig((v) => !v);
            }}
          >
            Host
          </button>
          <button className="rounded-lg bg-white/10 px-2.5 py-1.5 text-xs" onClick={() => setShowSettings((v) => !v)}>
            Settings
          </button>
        </div>
      </header>

      {showHostConfig ? (
        <section className="glass-card mt-3 space-y-2 rounded-2xl p-3 text-sm">
          <p className="font-semibold text-xs text-slate-200">Connection Mode</p>
          <div className="flex gap-2 mb-2">
            <button
              onClick={switchToCloudMode}
              className={`flex-1 rounded-xl py-2 text-xs font-semibold transition ${
                connectionMode === "cloud" ? "bg-violet-500 text-white" : "bg-white/10 text-slate-300"
              }`}
            >
              ☁ Cloud Relay (Any Network)
            </button>
            <button
              onClick={switchToDirectMode}
              className={`flex-1 rounded-xl py-2 text-xs font-semibold transition ${
                connectionMode === "websocket" ? "bg-cyan-500 text-slate-950" : "bg-white/10 text-slate-300"
              }`}
            >
              ⚡ Direct Wi-Fi (Same Network)
            </button>
          </div>
          {connectionMode === "websocket" ? (
            <>
              <p className="font-semibold text-xs text-slate-200">Desktop Companion IP Address</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={hostInput}
                  onChange={(e) => setHostInput(e.target.value)}
                  placeholder="e.g. 192.168.1.5"
                  className="flex-1 rounded-xl bg-black/40 px-3 py-1.5 text-xs text-white border border-white/15 outline-none focus:border-cyan-400"
                />
                <button
                  onClick={() => reconnectWithHost(hostInput)}
                  className="rounded-xl bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950"
                >
                  Connect
                </button>
              </div>
              <p className="text-[11px] text-slate-400">
                Enter your PC&apos;s local Wi-Fi IP address shown on the desktop dashboard.
              </p>
            </>
          ) : (
            <p className="text-[11px] text-slate-400">
              Cloud relay routes commands through the server. Your phone and laptop can be on different Wi-Fi networks or mobile 4G/5G.
            </p>
          )}
        </section>
      ) : null}

      {showSettings ? (
        <section className="glass-card mt-3 space-y-2 rounded-2xl p-3 text-sm">
          <label className="block">
            Sensitivity {settings.sensitivity.toFixed(2)}
            <input
              type="range"
              className="w-full"
              min={0.1}
              max={4}
              step={0.05}
              value={settings.sensitivity}
              onChange={(e) => setSettings({ ...settings, sensitivity: Number(e.target.value) })}
            />
          </label>
          <label className="block">
            Acceleration {settings.acceleration.toFixed(2)}
            <input
              type="range"
              className="w-full"
              min={1}
              max={3}
              step={0.05}
              value={settings.acceleration}
              onChange={(e) => setSettings({ ...settings, acceleration: Number(e.target.value) })}
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={settings.dragLock}
              onChange={(e) => setSettings({ ...settings, dragLock: e.target.checked })}
            />
            Drag lock
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={settings.tapToClick}
              onChange={(e) => setSettings({ ...settings, tapToClick: e.target.checked })}
            />
            Tap click
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={settings.twoFingerScroll}
              onChange={(e) => setSettings({ ...settings, twoFingerScroll: e.target.checked })}
            />
            Two finger scroll
          </label>
        </section>
      ) : null}

      <section
        ref={padRef}
        className="glass-card gradient-border mt-3 flex-[1_1_auto] rounded-3xl relative overflow-hidden"
        style={{ minHeight: "55vh", touchAction: "none", userSelect: "none" }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      >
        <div className="flex h-full flex-col items-center justify-center p-6 text-center select-none pointer-events-none">
          {companionActive ? (
            <div className="space-y-1">
              <span className="inline-block h-3 w-3 rounded-full bg-emerald-400 mb-2 shadow-[0_0_12px_#34d399]" />
              <p className="text-base font-semibold text-white">Touch &amp; Drag Trackpad</p>
              <p className="text-xs text-slate-400">Move your finger to control the computer cursor</p>
            </div>
          ) : connectionMode === "cloud" ? (
            <div className="space-y-2 max-w-xs">
              <span className="inline-block h-3 w-3 rounded-full bg-amber-400 mb-1 animate-pulse" />
              <p className="text-sm font-semibold text-amber-200">Waiting for PC Companion</p>
              <p className="text-xs text-slate-300">
                Commands are ready to send. Ensure the companion is running on your PC:
              </p>
              <code className="block rounded bg-black/60 p-1.5 text-[11px] font-mono text-cyan-300">
                npm run companion:dev
              </code>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-sm text-slate-400">Trackpad Connecting...</p>
            </div>
          )}
        </div>
      </section>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <button
          onClick={() => action(settings.leftHanded ? "right_click" : "left_click")}
          className="glossy-button rounded-2xl bg-cyan-500/20 py-3.5 font-semibold text-cyan-100 hover:bg-cyan-500/30"
        >
          Left Click
        </button>
        <button
          onClick={() => action(settings.leftHanded ? "left_click" : "right_click")}
          className="glossy-button rounded-2xl bg-violet-500/20 py-3.5 font-semibold text-violet-100 hover:bg-violet-500/30"
        >
          Right Click
        </button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <button className="rounded-xl bg-white/10 py-2.5 text-xs font-medium" onClick={() => action("maximize_window")}>
          ⛶ Maximize
        </button>
        <button className="rounded-xl bg-white/10 py-2.5 text-xs font-medium" onClick={() => action("zoom_in")}>
          ＋ Zoom In
        </button>
        <button className="rounded-xl bg-white/10 py-2.5 text-xs font-medium" onClick={() => action("zoom_out")}>
          － Zoom Out
        </button>
        <button className="rounded-xl bg-white/10 py-2.5 text-xs font-medium" onClick={() => action("restore_window")}>
          🗗 Restore
        </button>
        <button className="rounded-xl bg-white/10 py-2.5 text-xs font-medium" onClick={() => action("reset_zoom")}>
          Reset Zoom
        </button>
        <button
          className="rounded-xl bg-rose-500/20 py-2.5 text-xs font-medium text-rose-200"
          onClick={() => {
            action("disconnect");
            wsRef.current?.close();
          }}
        >
          Disconnect
        </button>
      </div>

      <div className="mt-2 text-center text-[11px] text-slate-400">
        Need help? <Link href="/dashboard" className="underline">Open desktop dashboard</Link>
      </div>
    </main>
  );
}
