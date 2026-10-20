"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { defaultSettings, settingsSchema, type ControlMessage, type ControllerSettings } from "@/lib/control-protocol";

type SocketState = "connecting" | "awaiting_approval" | "connected" | "disconnected" | "error";

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

  const [token, setToken] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return params.get("token") ?? "";
    }
    return "";
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

  const send = useCallback((msg: ControlMessage | { type: "pair_request"; token: string; deviceLabel: string; settings: ControllerSettings }) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

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

  // Connect to companion WebSocket server
  useEffect(() => {
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
          setStatusText("Connected");
        } else if (data.type === "waiting") {
          setSocketState("awaiting_approval");
          setStatusText("Awaiting approval");
        } else if (data.type === "rejected") {
          setSocketState("error");
          setStatusText(data.reason ?? "Pairing rejected");
        } else if (data.type === "disconnected") {
          setSocketState("disconnected");
          setStatusText(data.reason ?? "Disconnected");
        }
      } catch {
        setSocketState("error");
        setStatusText("Invalid server message");
      }
    };

    socket.onerror = () => {
      setSocketState("error");
      setStatusText(`Cannot reach ${wsHost}:${wsPort}`);
    };

    socket.onclose = () => {
      setSocketState("disconnected");
      setStatusText("Connection closed");
    };

    const heartbeat = setInterval(() => send({ type: "heartbeat" }), 2000);
    return () => {
      clearInterval(heartbeat);
      socket.close();
      wsRef.current = null;
    };
  }, [device, send, settings, token, wsHost, wsPort]);

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
    if (socketState !== "connected") return;
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
    if (socketState !== "connected") return;
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

  return (
    <main className="futuristic-bg flex min-h-screen flex-col px-3 pb-4 pt-3 text-white">
      <header className="glass-card gradient-border flex items-center justify-between rounded-2xl px-4 py-3">
        <div>
          <h1 className="text-base font-semibold">Mobile as Cursor</h1>
          <p className="text-xs text-slate-300">
            {statusText} {wsHost ? `(${wsHost})` : ""}
          </p>
        </div>
        <div className="flex gap-2">
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
        </section>
      ) : null}

      {showSettings ? (
        <section className="glass-card mt-3 space-y-2 rounded-2xl p-3 text-sm">
          <label className="block">Sensitivity {settings.sensitivity.toFixed(2)}
            <input type="range" className="w-full" min={0.1} max={4} step={0.05} value={settings.sensitivity} onChange={(e)=>setSettings({...settings,sensitivity:Number(e.target.value)})} />
          </label>
          <label className="block">Acceleration {settings.acceleration.toFixed(2)}
            <input type="range" className="w-full" min={1} max={3} step={0.05} value={settings.acceleration} onChange={(e)=>setSettings({...settings,acceleration:Number(e.target.value)})} />
          </label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={settings.dragLock} onChange={(e)=>setSettings({...settings,dragLock:e.target.checked})}/>Drag lock</label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={settings.tapToClick} onChange={(e)=>setSettings({...settings,tapToClick:e.target.checked})}/>Tap click</label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={settings.twoFingerScroll} onChange={(e)=>setSettings({...settings,twoFingerScroll:e.target.checked})}/>Two finger scroll</label>
        </section>
      ) : null}

      <section
        ref={padRef}
        className="glass-card gradient-border mt-3 flex-[1_1_auto] rounded-3xl"
        style={{ minHeight: "60vh", touchAction: "none", userSelect: "none" }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      >
        <div className="flex h-full items-center justify-center text-sm text-slate-300">
          {socketState === "connected" ? "Trackpad Active" : "Trackpad (Disconnected)"}
        </div>
      </section>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <button onClick={() => action(settings.leftHanded ? "right_click" : "left_click")} className="glossy-button rounded-2xl bg-cyan-500/20 py-3 font-semibold">
          Left Click
        </button>
        <button onClick={() => action(settings.leftHanded ? "left_click" : "right_click")} className="glossy-button rounded-2xl bg-violet-500/20 py-3 font-semibold">
          Right Click
        </button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <button className="rounded-xl bg-white/10 py-2" onClick={() => action("maximize_window")}>⛶ Maximize</button>
        <button className="rounded-xl bg-white/10 py-2" onClick={() => action("zoom_in")}>＋ Zoom In</button>
        <button className="rounded-xl bg-white/10 py-2" onClick={() => action("zoom_out")}>－ Zoom Out</button>
        <button className="rounded-xl bg-white/10 py-2" onClick={() => action("restore_window")}>🗗 Restore</button>
        <button className="rounded-xl bg-white/10 py-2" onClick={() => action("reset_zoom")}>Reset Zoom</button>
        <button
          className="rounded-xl bg-rose-500/20 py-2"
          onClick={() => {
            action("disconnect");
            wsRef.current?.close();
          }}
        >
          Disconnect
        </button>
      </div>

      {socketState !== "connected" ? (
        <div className="mt-3 text-center text-xs text-amber-200">
          {!token ? (
            <span>Scan QR code from desktop dashboard to obtain pairing token.</span>
          ) : (
            <span>Connection must be approved on your desktop PC dashboard.</span>
          )}
        </div>
      ) : null}

      <div className="mt-2 text-center text-[11px] text-slate-400">
        Need help? <Link href="/dashboard" className="underline">Open desktop dashboard</Link>
      </div>
    </main>
  );
}
