"use client";

import QRCode from "qrcode";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ControllerSettings, PairingStatus } from "@/lib/control-protocol";
import { defaultSettings } from "@/lib/control-protocol";

type CompanionStatus = {
  status: PairingStatus;
  hostIp: string;
  webPort: number;
  wsPort: number;
  pairingUrl: string | null;
  tokenExpiresAt: number | null;
  pendingRequest: { requestId: string; deviceLabel: string; requestedAt: number } | null;
  connectedDevice: { deviceLabel: string; connectedAt: number } | null;
  latencyMs: number | null;
  networkName: string;
  controlsEnabled: boolean;
  settings: ControllerSettings;
  message?: string;
};

const defaultCompanionUrl = process.env.NEXT_PUBLIC_COMPANION_URL ?? "http://127.0.0.1:4850";
const companionStorageKey = "mobile-as-cursor:companion-url";

export default function DashboardPage() {
  const [companionUrl, setCompanionUrl] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(companionStorageKey) ?? defaultCompanionUrl;
    }
    return defaultCompanionUrl;
  });

  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [now, setNow] = useState<number | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [customUrlInput, setCustomUrlInput] = useState(companionUrl);
  const [useCloudUrl, setUseCloudUrl] = useState(true);

  // Update a ticking timestamp for duration without impure calls during render
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const connectionDuration = useMemo(() => {
    if (!status?.connectedDevice || !now) return "—";
    const seconds = Math.max(0, Math.floor((now - status.connectedDevice.connectedAt) / 1000));
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `${min}m ${String(sec).padStart(2, "0")}s`;
  }, [status?.connectedDevice, now]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${companionUrl}/api/status`, { cache: "no-store" });
      const data = (await res.json()) as CompanionStatus;
      setStatus(data);
    } catch {
      setStatus({
        status: "Connection Failed",
        hostIp: "Unavailable",
        webPort: 3000,
        wsPort: 4850,
        pairingUrl: null,
        tokenExpiresAt: null,
        pendingRequest: null,
        connectedDevice: null,
        latencyMs: null,
        networkName: "Disconnected",
        controlsEnabled: false,
        settings: defaultSettings,
        message:
          "Desktop companion is not running or unreachable. Make sure companion is started on Windows.",
      });
    }
  }, [companionUrl]);

  // Polling companion with asynchronous invocation to prevent React 19 set-state-in-effect warning
  useEffect(() => {
    let isSubscribed = true;

    const execute = async () => {
      try {
        const res = await fetch(`${companionUrl}/api/status`, { cache: "no-store" });
        const data = (await res.json()) as CompanionStatus;
        if (isSubscribed) setStatus(data);
      } catch {
        if (isSubscribed) {
          setStatus({
            status: "Connection Failed",
            hostIp: "Unavailable",
            webPort: 3000,
            wsPort: 4850,
            pairingUrl: null,
            tokenExpiresAt: null,
            pendingRequest: null,
            connectedDevice: null,
            latencyMs: null,
            networkName: "Disconnected",
            controlsEnabled: false,
            settings: defaultSettings,
            message:
              "Desktop companion is not running or unreachable. Make sure companion is started on Windows.",
          });
        }
      }
    };

    const initialTimeout = setTimeout(() => {
      void execute();
    }, 0);

    const interval = setInterval(() => {
      void execute();
    }, 2000);

    return () => {
      isSubscribed = false;
      clearTimeout(initialTimeout);
      clearInterval(interval);
    };
  }, [companionUrl]);

  // Calculate actual pairing URL: either cloud-hosted (Vercel) or direct LAN
  const effectivePairingUrl = useMemo(() => {
    if (!status?.pairingUrl) return null;
    if (typeof window === "undefined") return status.pairingUrl;

    if (useCloudUrl && window.location.origin) {
      try {
        const parsed = new URL(status.pairingUrl);
        const token = parsed.searchParams.get("token") ?? "";
        const wsPort = parsed.searchParams.get("wsPort") ?? String(status.wsPort);
        const host = status.hostIp !== "Unavailable" ? status.hostIp : parsed.hostname;
        return `${window.location.origin}/remote?token=${encodeURIComponent(token)}&wsHost=${encodeURIComponent(host)}&wsPort=${encodeURIComponent(wsPort)}`;
      } catch {
        return status.pairingUrl;
      }
    }

    return status.pairingUrl;
  }, [status, useCloudUrl]);

  useEffect(() => {
    let active = true;
    const makeQR = async () => {
      if (!effectivePairingUrl) {
        if (active) setQrDataUrl("");
        return;
      }
      try {
        const url = await QRCode.toDataURL(effectivePairingUrl, { margin: 1, width: 512 });
        if (active) setQrDataUrl(url);
      } catch {
        if (active) setQrDataUrl("");
      }
    };
    void makeQR();
    return () => {
      active = false;
    };
  }, [effectivePairingUrl]);

  const apiAction = async (path: string, payload?: unknown) => {
    setBusy(path);
    try {
      await fetch(`${companionUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      await refresh();
    } finally {
      setBusy("");
    }
  };

  const saveCompanionUrl = (newUrl: string) => {
    const cleaned = newUrl.trim().replace(/\/$/, "");
    setCompanionUrl(cleaned);
    if (typeof window !== "undefined") {
      localStorage.setItem(companionStorageKey, cleaned);
    }
    setShowConfig(false);
  };

  const statusColor =
    status?.status === "Connected"
      ? "text-emerald-400"
      : status?.status === "Awaiting Approval"
        ? "text-amber-300"
        : status?.status === "Connection Failed"
          ? "text-rose-400"
          : "text-sky-300";

  const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";

  return (
    <main className="futuristic-bg min-h-screen px-4 py-6 sm:px-7">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="glass-card gradient-border rounded-2xl px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="bg-gradient-to-r from-violet-300 via-cyan-300 to-pink-400 bg-clip-text text-2xl font-bold text-transparent">
                Mobile as Cursor
              </h1>
              <p className="text-sm text-slate-300">Desktop pairing dashboard</p>
            </div>
            <nav className="flex items-center gap-3 text-sm text-slate-200">
              <button
                onClick={() => setShowConfig((v) => !v)}
                className="rounded-full bg-cyan-500/20 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/30"
              >
                Companion: {companionUrl.replace(/^https?:\/\//, "")}
              </button>
              <Link href="/dashboard" className="rounded-full bg-white/10 px-3 py-1.5 hover:bg-white/20">
                Dashboard
              </Link>
              <Link href="/settings" className="rounded-full bg-white/10 px-3 py-1.5 hover:bg-white/20">
                Settings
              </Link>
            </nav>
          </div>
        </header>

        {showConfig ? (
          <div className="glass-card gradient-border rounded-2xl p-4 text-sm text-slate-200">
            <h3 className="font-semibold text-white">Configure Desktop Companion Address</h3>
            <p className="mt-1 text-xs text-slate-400">
              When deployed to Vercel, the dashboard runs in your browser and connects to your local PC.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                type="text"
                value={customUrlInput}
                onChange={(e) => setCustomUrlInput(e.target.value)}
                placeholder="http://127.0.0.1:4850"
                className="flex-1 rounded-xl bg-black/40 px-3 py-2 text-sm text-white border border-white/15 outline-none focus:border-cyan-400"
              />
              <button
                onClick={() => saveCompanionUrl(customUrlInput)}
                className="rounded-xl bg-cyan-500 px-4 py-2 font-medium text-slate-950 hover:bg-cyan-400"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setCustomUrlInput(defaultCompanionUrl);
                  saveCompanionUrl(defaultCompanionUrl);
                }}
                className="rounded-xl bg-white/10 px-3 py-2 hover:bg-white/15"
              >
                Reset Default
              </button>
            </div>
          </div>
        ) : null}

        {isHttps && companionUrl.startsWith("http://") && status?.status === "Connection Failed" ? (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
            <strong>Notice for HTTPS (Vercel):</strong> Your browser might block mixed-content requests from HTTPS to local HTTP ({companionUrl}). If pairing doesn&apos;t connect, either:
            <ul className="mt-1 list-disc pl-5 space-y-0.5">
              <li>Allow insecure content / private network access for this site in your browser site permissions.</li>
              <li>Or use a tunnel (e.g. Cloudflare Tunnel or ngrok) for companion and set its HTTPS address above.</li>
              <li>Or access the dashboard locally at <code>http://localhost:3000</code>.</li>
            </ul>
          </div>
        ) : null}

        <section className="grid gap-6 lg:grid-cols-[1.1fr,0.9fr]">
          <article className="glass-card gradient-border rounded-3xl p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Pair with Smartphone</h2>
              <div className={`flex items-center gap-2 text-sm ${statusColor}`}>
                <span className="status-dot bg-current" />
                <span>{status?.status ?? "Checking..."}</span>
              </div>
            </div>

            <div className="mx-auto flex max-w-md items-center justify-center rounded-2xl bg-white p-4 shadow-[0_0_40px_rgba(56,189,248,0.28)]">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt="Pairing QR code" className="h-full w-full rounded-lg" />
              ) : (
                <div className="grid h-72 w-72 place-items-center rounded-lg bg-slate-900 text-slate-300">
                  {status?.status === "Connection Failed" ? "Companion offline" : "Generating QR..."}
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center justify-center gap-4 text-xs text-slate-300">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useCloudUrl}
                  onChange={(e) => setUseCloudUrl(e.target.checked)}
                  className="rounded"
                />
                <span>Generate QR with current domain ({typeof window !== "undefined" ? window.location.host : "cloud"})</span>
              </label>
            </div>

            <p className="mt-3 text-center text-sm text-slate-200">
              Scan this QR code with your smartphone to connect and start controlling your computer.
            </p>

            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <button
                onClick={() => apiAction("/api/pairing/new")}
                className="glossy-button rounded-xl bg-cyan-500/20 px-4 py-2 text-sm font-medium text-cyan-100 hover:bg-cyan-500/30"
                disabled={busy.length > 0}
              >
                Generate Fresh QR
              </button>
              <button
                onClick={async () => {
                  if (!effectivePairingUrl) return;
                  await navigator.clipboard.writeText(effectivePairingUrl);
                }}
                className="glossy-button rounded-xl bg-violet-500/20 px-4 py-2 text-sm font-medium text-violet-100 hover:bg-violet-500/30"
              >
                Copy Link
              </button>
              <button
                onClick={() => apiAction("/api/disconnect")}
                className="glossy-button rounded-xl bg-rose-500/20 px-4 py-2 text-sm font-medium text-rose-100 hover:bg-rose-500/30"
                disabled={busy.length > 0}
              >
                Disconnect
              </button>
            </div>
          </article>

          <aside className="glass-card gradient-border rounded-3xl p-6">
            <h3 className="text-lg font-semibold">Connection Details</h3>
            <dl className="mt-4 space-y-3 text-sm text-slate-200">
              <div className="flex justify-between gap-3"><dt>LAN Interface</dt><dd>{status?.networkName ?? "-"}</dd></div>
              <div className="flex justify-between gap-3"><dt>Host</dt><dd>{status?.hostIp ?? "-"}</dd></div>
              <div className="flex justify-between gap-3"><dt>Web Port</dt><dd>{status?.webPort ?? "-"}</dd></div>
              <div className="flex justify-between gap-3"><dt>WebSocket Port</dt><dd>{status?.wsPort ?? "-"}</dd></div>
              <div className="flex justify-between gap-3"><dt>Connected Device</dt><dd>{status?.connectedDevice?.deviceLabel ?? "None"}</dd></div>
              <div className="flex justify-between gap-3"><dt>Duration</dt><dd>{connectionDuration}</dd></div>
              <div className="flex justify-between gap-3"><dt>Approx Latency</dt><dd>{status?.latencyMs ? `${status.latencyMs} ms` : "—"}</dd></div>
            </dl>

            {status?.pendingRequest ? (
              <div className="mt-5 rounded-2xl bg-amber-400/10 p-4 text-sm text-amber-100">
                <p className="font-semibold">Awaiting approval from desktop</p>
                <p className="mt-1">Device: {status.pendingRequest.deviceLabel}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => apiAction("/api/pairing/approve", { requestId: status.pendingRequest?.requestId })}
                    className="rounded-lg bg-emerald-400/20 px-3 py-1.5 hover:bg-emerald-400/35"
                    disabled={busy.length > 0}
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => apiAction("/api/pairing/reject", { requestId: status.pendingRequest?.requestId })}
                    className="rounded-lg bg-rose-400/20 px-3 py-1.5 hover:bg-rose-400/35"
                    disabled={busy.length > 0}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ) : null}

            {status?.message ? <p className="mt-5 rounded-xl bg-white/10 p-3 text-xs text-slate-200">{status.message}</p> : null}
          </aside>
        </section>
      </div>
    </main>
  );
}
