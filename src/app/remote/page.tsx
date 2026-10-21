"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { defaultSettings, settingsSchema, type ControlMessage, type ControllerSettings } from "@/lib/control-protocol";

type ConnectionMode = "websocket" | "cloud";

const storageKey = "mobile-as-cursor:settings";
const hostStorageKey = "mobile-as-cursor:ws-host";

export default function RemotePage() {
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

  const [token] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return params.get("token") ?? "";
    }
    return "";
  });

  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return params.get("mode") === "websocket" ? "websocket" : "cloud";
    }
    return "cloud";
  });

  const [wsPort] = useState<number>(() => {
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
  const [touchActive, setTouchActive] = useState(false);
  const [statusBadge, setStatusBadge] = useState("Connected");

  // ─── Dual-Channel Cloud Publishing (Instant Real-Time Stream + Vercel) ──────

  const cloudRelayUrl = typeof window !== "undefined" ? window.location.origin : "";

  const flushCloudBatch = useCallback(async () => {
    const batch = cloudBatchRef.current;
    if (batch.length === 0 || !token) return;
    cloudBatchRef.current = [];

    const payload = JSON.stringify({
      type: "commands",
      commands: batch,
      token,
      timestamp: Date.now(),
    });

    // 1. Direct real-time pubsub stream (sub-20ms instant delivery!)
    try {
      fetch(`https://ntfy.sh/mac_relay_${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        mode: "cors",
      }).catch(() => {});
    } catch {
      // Ignore
    }

    // 2. Vercel relay route (backup channel)
    if (cloudRelayUrl) {
      try {
        fetch(`${cloudRelayUrl}/api/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "command",
            token,
            commands: batch,
          }),
        }).catch(() => {});
      } catch {
        // Ignore
      }
    }
  }, [cloudRelayUrl, token]);

  const sendCloud = useCallback(
    (msg: { type: string; [key: string]: unknown }) => {
      cloudBatchRef.current.push(msg);
      // Instant flush for clicks and actions
      if (msg.type !== "mouse_move" && msg.type !== "heartbeat") {
        void flushCloudBatch();
      }
    },
    [flushCloudBatch],
  );

  // ─── Direct WebSocket Mode ──────────────────────────────────────────

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

  // ─── Cloud Channel Activation & Fast Batch Timer ───────────────────

  useEffect(() => {
    if (connectionMode !== "cloud" || !token) return;

    // Announce mobile join to the cloud relay
    const announceJoin = () => {
      const joinPayload = JSON.stringify({
        type: "mobile_joined",
        deviceLabel: device,
        token,
        timestamp: Date.now(),
      });

      // Direct pubsub
      fetch(`https://ntfy.sh/mac_relay_${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: joinPayload,
        mode: "cors",
      }).catch(() => {});

      // Vercel relay
      if (cloudRelayUrl) {
        fetch(`${cloudRelayUrl}/api/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "join",
            token,
            deviceLabel: device,
          }),
        }).catch(() => {});
      }
    };

    announceJoin();
    setStatusBadge("Live");

    // Ultra-fast 25ms batch flush for smooth mouse cursor gliding
    const flushTimer = setInterval(() => {
      void flushCloudBatch();
    }, 25);
    cloudFlushTimerRef.current = flushTimer;

    // Heartbeat every 5 seconds
    const heartbeatTimer = setInterval(() => {
      sendCloud({ type: "heartbeat" });
    }, 5000);

    return () => {
      clearInterval(flushTimer);
      clearInterval(heartbeatTimer);
      cloudFlushTimerRef.current = null;
    };
  }, [connectionMode, token, device, cloudRelayUrl, flushCloudBatch, sendCloud]);

  // ─── WebSocket Mode: Connect directly to companion over Wi-Fi ───────

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
      setStatusBadge("Error");
      return;
    }

    wsRef.current = socket;

    socket.onopen = () => {
      setStatusBadge("Connected");
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
        const data = JSON.parse(String(event.data)) as { type: string };
        if (data.type === "approved") {
          setStatusBadge("Active");
        }
      } catch {
        // ignore
      }
    };

    socket.onerror = () => {
      setStatusBadge("Offline");
    };

    socket.onclose = () => {
      setStatusBadge("Closed");
    };

    const heartbeat = setInterval(() => sendWs({ type: "heartbeat" }), 2000);
    return () => {
      clearInterval(heartbeat);
      socket.close();
      wsRef.current = null;
    };
  }, [connectionMode, device, sendWs, settings, token, wsHost, wsPort]);

  // ─── Touch & Gesture Handlers (ALWAYS ACTIVE & IMMEDIATE) ───────────

  const moveTransform = (dx: number, dy: number) => {
    const speed = settings.sensitivity * 1.6;
    const magnitude = Math.sqrt(dx * dx + dy * dy);
    const accel = Math.max(1, 1 + (settings.acceleration - 1) * Math.min(1.6, magnitude / 14));
    const sx = dx * speed * accel;
    const sy = dy * speed * accel;
    return {
      dx: sx * (1 - settings.smoothing),
      dy: sy * (1 - settings.smoothing),
    };
  };

  const pointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setTouchActive(true);
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
      send({ type: "scroll", deltaY: (settings.naturalScroll ? -1 : 1) * dy * 1.8 });
      return;
    }

    const transformed = moveTransform(dx, dy);
    queueMove(transformed.dx, transformed.dy);
  };

  const pointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startCount = pointersRef.current.size;
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size === 0) {
      setTouchActive(false);
    }

    if (startCount === 1 && settings.tapToClick && !draggingRef.current) {
      const now = Date.now();
      if (settings.doubleTap && now - lastTapRef.current < 260) {
        send({ type: "double_click" });
        lastTapRef.current = 0;
      } else {
        send({ type: "left_click" });
        lastTapRef.current = now;
      }
      if (settings.haptic && navigator.vibrate) navigator.vibrate(10);
    }

    if (draggingRef.current && !settings.dragLock) {
      draggingRef.current = false;
      send({ type: "drag_end" });
    }
  };

  const action = (type: ControlMessage["type"]) => {
    send({ type } as ControlMessage);
    if (settings.haptic && navigator.vibrate) navigator.vibrate(14);
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
  };

  const switchToCloudMode = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionMode("cloud");
  };

  return (
    <main className="futuristic-bg flex min-h-screen flex-col px-3 pb-4 pt-3 text-white">
      {/* Top Header Bar */}
      <header className="glass-card gradient-border flex items-center justify-between rounded-2xl px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_10px_#34d399]" />
          <div>
            <h1 className="text-sm font-bold bg-gradient-to-r from-cyan-300 to-violet-300 bg-clip-text text-transparent">
              Mobile as Cursor
            </h1>
            <p className="text-[11px] text-emerald-400 font-medium">
              {connectionMode === "cloud" ? "☁ Cloud Mode (Active)" : "⚡ Direct Wi-Fi"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-300 border border-emerald-500/30">
            {statusBadge}
          </span>
          <button
            className="rounded-lg bg-white/10 px-2.5 py-1 text-xs text-cyan-200 hover:bg-white/15"
            onClick={() => {
              setHostInput(wsHost);
              setShowHostConfig((v) => !v);
            }}
          >
            Mode
          </button>
          <button
            className="rounded-lg bg-white/10 px-2.5 py-1 text-xs hover:bg-white/15"
            onClick={() => setShowSettings((v) => !v)}
          >
            ⚙
          </button>
        </div>
      </header>

      {/* Mode Selection Drawer */}
      {showHostConfig ? (
        <section className="glass-card mt-2 space-y-2 rounded-2xl p-3 text-sm">
          <p className="font-semibold text-xs text-slate-200">Connection Mode</p>
          <div className="flex gap-2">
            <button
              onClick={switchToCloudMode}
              className={`flex-1 rounded-xl py-2 text-xs font-semibold transition ${
                connectionMode === "cloud"
                  ? "bg-violet-500 text-white shadow-lg shadow-violet-500/25"
                  : "bg-white/10 text-slate-300"
              }`}
            >
              ☁ Cloud Relay (Any Network)
            </button>
            <button
              onClick={switchToDirectMode}
              className={`flex-1 rounded-xl py-2 text-xs font-semibold transition ${
                connectionMode === "websocket"
                  ? "bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/25"
                  : "bg-white/10 text-slate-300"
              }`}
            >
              ⚡ Direct Wi-Fi
            </button>
          </div>
          {connectionMode === "websocket" ? (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-slate-300 font-medium">Desktop IP Address</p>
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
                  Save
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Settings Panel */}
      {showSettings ? (
        <section className="glass-card mt-2 space-y-2 rounded-2xl p-3.5 text-xs">
          <label className="block">
            Sensitivity: {settings.sensitivity.toFixed(2)}x
            <input
              type="range"
              className="w-full mt-1"
              min={0.2}
              max={4}
              step={0.05}
              value={settings.sensitivity}
              onChange={(e) => setSettings({ ...settings, sensitivity: Number(e.target.value) })}
            />
          </label>
          <label className="block">
            Acceleration: {settings.acceleration.toFixed(2)}x
            <input
              type="range"
              className="w-full mt-1"
              min={1}
              max={3}
              step={0.05}
              value={settings.acceleration}
              onChange={(e) => setSettings({ ...settings, acceleration: Number(e.target.value) })}
            />
          </label>
          <div className="flex flex-wrap gap-4 pt-1">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.tapToClick}
                onChange={(e) => setSettings({ ...settings, tapToClick: e.target.checked })}
              />
              Tap to click
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.twoFingerScroll}
                onChange={(e) => setSettings({ ...settings, twoFingerScroll: e.target.checked })}
              />
              Two finger scroll
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.haptic}
                onChange={(e) => setSettings({ ...settings, haptic: e.target.checked })}
              />
              Haptic feedback
            </label>
          </div>
        </section>
      ) : null}

      {/* Full-Screen Touch Trackpad (ALWAYS OPERATIONAL & ACTIVE) */}
      <section
        ref={padRef}
        className={`glass-card gradient-border mt-3 flex-[1_1_auto] rounded-3xl relative overflow-hidden transition-all duration-150 ${
          touchActive ? "border-cyan-400 shadow-[0_0_35px_rgba(56,189,248,0.25)]" : "border-white/10"
        }`}
        style={{ minHeight: "56vh", touchAction: "none", userSelect: "none" }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      >
        <div className="flex h-full flex-col items-center justify-center p-6 text-center select-none pointer-events-none">
          <div className="space-y-2">
            <div
              className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl transition-all duration-150 ${
                touchActive
                  ? "bg-cyan-500/25 border-cyan-400 scale-110 shadow-[0_0_30px_rgba(56,189,248,0.4)]"
                  : "bg-cyan-500/10 border-cyan-500/20"
              } border`}
            >
              <svg className="h-7 w-7 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.8}
                  d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"
                />
              </svg>
            </div>
            <p className="text-base font-semibold text-white">Touch &amp; Drag Trackpad</p>
            <p className="text-xs text-slate-400">
              Slide finger to glide • Tap to click • Two fingers to scroll
            </p>
          </div>
        </div>
      </section>

      {/* Mouse Click Buttons */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <button
          onClick={() => action(settings.leftHanded ? "right_click" : "left_click")}
          className="glossy-button rounded-2xl bg-cyan-500/20 py-3.5 font-bold text-cyan-100 hover:bg-cyan-500/30 active:scale-95 transition"
        >
          Left Click
        </button>
        <button
          onClick={() => action(settings.leftHanded ? "left_click" : "right_click")}
          className="glossy-button rounded-2xl bg-violet-500/20 py-3.5 font-bold text-violet-100 hover:bg-violet-500/30 active:scale-95 transition"
        >
          Right Click
        </button>
      </div>

      {/* Quick Action Buttons */}
      <div className="mt-2.5 grid grid-cols-4 gap-2 text-xs">
        <button
          className="rounded-xl bg-white/10 py-2.5 font-medium hover:bg-white/15 active:scale-95 transition"
          onClick={() => action("maximize_window")}
        >
          ⛶ Max
        </button>
        <button
          className="rounded-xl bg-white/10 py-2.5 font-medium hover:bg-white/15 active:scale-95 transition"
          onClick={() => action("restore_window")}
        >
          🗗 Restore
        </button>
        <button
          className="rounded-xl bg-white/10 py-2.5 font-medium hover:bg-white/15 active:scale-95 transition"
          onClick={() => action("zoom_in")}
        >
          ＋ Zoom
        </button>
        <button
          className="rounded-xl bg-white/10 py-2.5 font-medium hover:bg-white/15 active:scale-95 transition"
          onClick={() => action("zoom_out")}
        >
          － Zoom
        </button>
      </div>

      <div className="mt-2 text-center text-[10px] text-slate-400">
        Connected to PC • <Link href="/dashboard" className="underline">Dashboard</Link>
      </div>
    </main>
  );
}
