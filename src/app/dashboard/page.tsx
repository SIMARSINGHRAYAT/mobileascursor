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
  cloudPairingUrl?: string | null;
  tokenExpiresAt: number | null;
  pendingRequest: { requestId: string; deviceLabel: string; requestedAt: number } | null;
  connectedDevice: { deviceLabel: string; connectedAt: number } | null;
  latencyMs: number | null;
  networkName: string;
  controlsEnabled: boolean;
  settings: ControllerSettings;
  cloudRelayActive?: boolean;
  activeRelayUrl?: string | null;
  cloudMobileConnected?: boolean;
  message?: string;
};

type NetworkInterface = {
  name: string;
  address: string;
};

const defaultCompanionUrl = process.env.NEXT_PUBLIC_COMPANION_URL ?? "http://127.0.0.1:4850";
const companionStorageKey = "mobile-as-cursor:companion-url";
const customHostStorageKey = "mobile-as-cursor:custom-host";

function generateToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export default function DashboardPage() {
  const [companionUrl, setCompanionUrl] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(companionStorageKey) ?? defaultCompanionUrl;
    }
    return defaultCompanionUrl;
  });

  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [localToken, setLocalToken] = useState<string>(() => generateToken());
  const [localExpiresAt, setLocalExpiresAt] = useState<number>(() => Date.now() + 15 * 60_000);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");

  const [busy, setBusy] = useState<string>("");
  const [now, setNow] = useState<number>(() => Date.now());

  const [showConfig, setShowConfig] = useState(false);
  const [customUrlInput, setCustomUrlInput] = useState(companionUrl);
  const [pairingMode, setPairingMode] = useState<"cloud" | "direct" | "lan_web">("cloud");
  const [copied, setCopied] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  // Status checked directly from Vercel Cloud Relay API
  const [relayServerCompanionActive, setRelayServerCompanionActive] = useState(false);
  const [relayServerMobileActive, setRelayServerMobileActive] = useState(false);

  // Network interfaces from companion
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [selectedHost, setSelectedHost] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(customHostStorageKey) ?? "";
    }
    return "";
  });

  // Ticking timer for live expiration and connection duration
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Poll companion status
  useEffect(() => {
    let isSubscribed = true;

    const execute = async () => {
      try {
        const res = await fetch(`${companionUrl}/api/status`, { cache: "no-store" });
        const data = (await res.json()) as CompanionStatus;
        if (isSubscribed) {
          setStatus(data);
          // If companion provides a valid token, sync it
          if (data.pairingUrl) {
            try {
              const parsed = new URL(data.pairingUrl);
              const t = parsed.searchParams.get("token");
              if (t) setLocalToken(t);
            } catch {
              // ignore url parse error
            }
          }
          if (data.tokenExpiresAt) {
            setLocalExpiresAt(data.tokenExpiresAt);
          }
        }
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
              "Desktop companion is not detected on this machine. Start it with: npm run companion:dev",
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

  // Also query Vercel Cloud Relay API to verify companion presence independently
  useEffect(() => {
    if (!localToken) return;
    let isSubscribed = true;

    const checkRelay = async () => {
      try {
        const res = await fetch(`/api/relay?token=${encodeURIComponent(localToken)}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          ok: boolean;
          companionActive?: boolean;
          mobileActive?: boolean;
        };
        if (isSubscribed && data.ok) {
          setRelayServerCompanionActive(Boolean(data.companionActive));
          setRelayServerMobileActive(Boolean(data.mobileActive));
        }
      } catch {
        // Ignore fetch errors
      }
    };

    void checkRelay();
    const timer = setInterval(() => {
      void checkRelay();
    }, 2500);

    return () => {
      isSubscribed = false;
      clearInterval(timer);
    };
  }, [localToken]);

  // Fetch available network adapters from companion
  useEffect(() => {
    let isSubscribed = true;
    const fetchInterfaces = async () => {
      try {
        const res = await fetch(`${companionUrl}/api/interfaces`, { cache: "no-store" });
        const data = (await res.json()) as { selected?: NetworkInterface; interfaces?: NetworkInterface[] };
        if (isSubscribed && Array.isArray(data.interfaces)) {
          setInterfaces(data.interfaces);
        }
      } catch {
        // companion offline
      }
    };

    const timeout = setTimeout(() => {
      void fetchInterfaces();
    }, 100);

    return () => {
      isSubscribed = false;
      clearTimeout(timeout);
    };
  }, [companionUrl, status?.status]);

  // Determine effective host for the QR code
  const effectiveHost = useMemo(() => {
    if (selectedHost) return selectedHost;
    if (status?.hostIp && status.hostIp !== "Unavailable") return status.hostIp;
    if (interfaces.length > 0 && interfaces[0]?.address) return interfaces[0].address;
    if (typeof window !== "undefined" && window.location.hostname && window.location.hostname !== "localhost") {
      return window.location.hostname;
    }
    return "127.0.0.1";
  }, [selectedHost, status?.hostIp, interfaces]);

  const effectivePort = status?.wsPort ?? 4850;
  const webPort = status?.webPort ?? 3000;

  // Active token and expiration calculation
  const isExpired = now > localExpiresAt;
  const secondsLeft = Math.max(0, Math.floor((localExpiresAt - now) / 1000));
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const formattedCountdown = `${minutes}:${String(seconds).padStart(2, "0")}`;

  // Build the fully functional pairing URL
  const effectivePairingUrl = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";

    if (pairingMode === "cloud" && origin) {
      // Cloud mode: phone connects to Vercel origin with mode=cloud
      return `${origin}/remote?token=${encodeURIComponent(localToken)}&mode=cloud`;
    }

    const currentHost = typeof window !== "undefined" ? window.location.hostname : "localhost";
    const hostForUrl = effectiveHost === "127.0.0.1" || effectiveHost === "localhost" ? currentHost : effectiveHost;

    if (pairingMode === "direct") {
      // Direct mode: phone connects straight to companion port
      return `http://${hostForUrl}:${effectivePort}/remote?token=${encodeURIComponent(localToken)}`;
    }

    // LAN Web mode: phone connects to Next.js dev server on LAN
    return `http://${hostForUrl}:${webPort}/remote?token=${encodeURIComponent(localToken)}&wsHost=${encodeURIComponent(effectiveHost)}&wsPort=${encodeURIComponent(effectivePort)}`;
  }, [effectiveHost, effectivePort, localToken, pairingMode, webPort]);

  // Generate the QR code data URL whenever the pairing URL changes
  useEffect(() => {
    let active = true;
    const generateQRCode = async () => {
      if (!effectivePairingUrl) {
        if (active) setQrDataUrl("");
        return;
      }
      try {
        const url = await QRCode.toDataURL(effectivePairingUrl, {
          errorCorrectionLevel: "H",
          margin: 2,
          width: 512,
          color: {
            dark: "#030712",
            light: "#ffffff",
          },
        });
        if (active) setQrDataUrl(url);
      } catch (err) {
        console.error("QR Code generation error:", err);
        if (active) setQrDataUrl("");
      }
    };

    void generateQRCode();
    return () => {
      active = false;
    };
  }, [effectivePairingUrl]);

  // Activate Cloud Relay on Companion
  const activateCloudRelay = useCallback(async () => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    if (!origin) return;

    setBusy("cloud_relay");
    try {
      await fetch(`${companionUrl}/api/cloud-relay/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relayUrl: origin, token: localToken }),
      });
      // refresh status immediately
      const res = await fetch(`${companionUrl}/api/status`, { cache: "no-store" });
      const data = (await res.json()) as CompanionStatus;
      setStatus(data);
    } catch {
      // Offline / blocked
    } finally {
      setBusy("");
    }
  }, [companionUrl, localToken]);

  // Switch mode and automatically start cloud relay if needed
  const selectPairingMode = (mode: "cloud" | "direct" | "lan_web") => {
    setPairingMode(mode);
    if (mode === "cloud") {
      void activateCloudRelay();
    }
  };

  // API actions with companion
  const apiAction = async (path: string, payload?: unknown) => {
    setBusy(path);
    try {
      await fetch(`${companionUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      // refresh status immediately
      const res = await fetch(`${companionUrl}/api/status`, { cache: "no-store" });
      const data = (await res.json()) as CompanionStatus;
      setStatus(data);
    } catch {
      // offline
    } finally {
      setBusy("");
    }
  };

  // Generate a fresh pairing QR code (works both with companion online and offline)
  const generateFreshQR = async () => {
    setBusy("generate_qr");
    const newToken = generateToken();
    const newExpires = Date.now() + 15 * 60_000;
    setLocalToken(newToken);
    setLocalExpiresAt(newExpires);

    const origin = typeof window !== "undefined" ? window.location.origin : "";

    try {
      // If companion is online, register the fresh token
      await fetch(`${companionUrl}/api/pairing/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: newToken,
          ttlMinutes: 15,
          relayUrl: pairingMode === "cloud" ? origin : undefined,
        }),
      });
    } catch {
      // Companion offline, local token already generated
    } finally {
      setBusy("");
    }
  };

  const handleCopyLink = async () => {
    if (!effectivePairingUrl) return;
    try {
      await navigator.clipboard.writeText(effectivePairingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const handleDownloadQR = () => {
    if (!qrDataUrl) return;
    const a = document.createElement("a");
    a.href = qrDataUrl;
    a.download = `mobile-as-cursor-qr-${pairingMode}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleSelectInterface = async (address: string) => {
    setSelectedHost(address);
    if (typeof window !== "undefined") {
      localStorage.setItem(customHostStorageKey, address);
    }
    try {
      await fetch(`${companionUrl}/api/interface/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
    } catch {
      // companion offline
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

  const originUrl = typeof window !== "undefined" ? window.location.origin : "";
  const companionCliCommand = `npm run companion:dev -- --relay ${originUrl}`;

  const handleCopyCliCommand = async () => {
    try {
      await navigator.clipboard.writeText(companionCliCommand);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 2500);
    } catch {
      // fallback
    }
  };

  const connectionDuration = useMemo(() => {
    if (!status?.connectedDevice || !now) return "—";
    const seconds = Math.max(0, Math.floor((now - status.connectedDevice.connectedAt) / 1000));
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `${min}m ${String(sec).padStart(2, "0")}s`;
  }, [status, now]);

  const isCompanionConnected = status && status.status !== "Connection Failed";
  const isCloudRelayActive = Boolean(status?.cloudRelayActive || relayServerCompanionActive);

  const statusColor =
    status?.status === "Connected" || relayServerMobileActive
      ? "text-emerald-400"
      : status?.status === "Awaiting Approval"
        ? "text-amber-300"
        : status?.status === "Ready to Pair" || isCloudRelayActive
          ? "text-cyan-300"
          : status?.status === "Connection Failed"
            ? "text-rose-400"
            : "text-sky-300";

  return (
    <main className="futuristic-bg min-h-screen px-4 py-6 sm:px-7">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        {/* Navigation & Header */}
        <header className="glass-card gradient-border rounded-2xl px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="bg-gradient-to-r from-violet-300 via-cyan-300 to-pink-400 bg-clip-text text-2xl font-bold text-transparent">
                Mobile as Cursor
              </h1>
              <p className="text-sm text-slate-300">Desktop pairing dashboard &amp; QR manager</p>
            </div>
            <nav className="flex items-center gap-3 text-sm text-slate-200">
              <button
                onClick={() => setShowConfig((v) => !v)}
                className={`rounded-full px-3 py-1.5 text-xs transition ${
                  isCompanionConnected
                    ? "bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30 border border-emerald-500/30"
                    : isCloudRelayActive
                      ? "bg-violet-500/20 text-violet-200 hover:bg-violet-500/30 border border-violet-500/30"
                      : "bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 border border-amber-500/30"
                }`}
              >
                Companion: {isCompanionConnected ? "● Live (Local)" : isCloudRelayActive ? "☁ Live (Relay)" : "○ Offline"}
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

        {/* Companion URL Config Drawer */}
        {showConfig ? (
          <div className="glass-card gradient-border rounded-2xl p-4 text-sm text-slate-200">
            <h3 className="font-semibold text-white">Configure Desktop Companion Address</h3>
            <p className="mt-1 text-xs text-slate-400">
              The dashboard talks to the companion server running on your computer (default: <code>http://127.0.0.1:4850</code>).
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

        {/* Main Grid: QR Code Studio & Status Sidebar */}
        <section className="grid gap-6 lg:grid-cols-[1.15fr,0.85fr]">
          {/* QR Code Presentation Box */}
          <article className="glass-card gradient-border rounded-3xl p-6 flex flex-col justify-between">
            <div>
              {/* Header */}
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-xl font-semibold text-white">Pair with Smartphone</h2>
                  <p className="text-xs text-slate-400">Scan QR to turn your phone into a wireless trackpad</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`status-dot bg-current ${statusColor}`} />
                  <span className={`text-sm font-medium ${statusColor}`}>
                    {relayServerMobileActive || status?.status === "Connected"
                      ? "Phone Connected"
                      : isCloudRelayActive
                        ? "Cloud Relay Ready"
                        : status?.status ?? "Ready to Pair"}
                  </span>
                </div>
              </div>

              {/* Mode Switcher Tabs */}
              <div className="mb-4 grid grid-cols-2 gap-2 rounded-2xl bg-black/40 p-1.5 border border-white/10">
                <button
                  onClick={() => selectPairingMode("cloud")}
                  className={`flex flex-col items-center justify-center rounded-xl py-2 px-3 text-xs font-semibold transition ${
                    pairingMode === "cloud"
                      ? "bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-500/25"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span>☁️ Cloud Mode</span>
                    <span className="rounded bg-violet-400/20 px-1 py-0.2 text-[10px] text-violet-200">Recommended</span>
                  </span>
                  <span className="text-[10px] font-normal text-slate-300 mt-0.5">Works on any network (4G, 5G, Wi-Fi)</span>
                </button>

                <button
                  onClick={() => selectPairingMode("direct")}
                  className={`flex flex-col items-center justify-center rounded-xl py-2 px-3 text-xs font-semibold transition ${
                    pairingMode === "direct"
                      ? "bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/25"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span>⚡ Direct Wi-Fi</span>
                  </span>
                  <span className="text-[10px] font-normal text-slate-400 mt-0.5">Requires same Wi-Fi router</span>
                </button>
              </div>

              {/* QR Code Canvas */}
              <div className="relative mx-auto my-3 flex flex-col items-center justify-center">
                <div className="relative rounded-3xl bg-white p-5 shadow-[0_0_50px_rgba(56,189,248,0.3)] transition-transform duration-200 hover:scale-[1.01]">
                  {qrDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={qrDataUrl}
                      alt="Pairing QR code"
                      className="h-64 w-64 rounded-xl sm:h-72 sm:w-72 object-contain"
                    />
                  ) : (
                    <div className="grid h-64 w-64 sm:h-72 sm:w-72 place-items-center rounded-xl bg-slate-900 text-slate-400 text-sm">
                      <div className="flex flex-col items-center gap-2">
                        <span className="animate-spin h-6 w-6 border-2 border-cyan-400 border-t-transparent rounded-full" />
                        <span>Generating QR Code...</span>
                      </div>
                    </div>
                  )}

                  {/* Expired Overlay */}
                  {isExpired ? (
                    <div className="absolute inset-0 rounded-3xl bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center">
                      <p className="text-rose-400 font-semibold text-base mb-1">Token Expired</p>
                      <p className="text-xs text-slate-300 mb-3">Pairing tokens expire for security.</p>
                      <button
                        onClick={generateFreshQR}
                        className="rounded-xl bg-cyan-400 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-cyan-300"
                      >
                        Regenerate QR
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* Expiration Countdown Bar */}
                <div className="mt-3 flex items-center gap-2 text-xs">
                  <span className="text-slate-400">Token Validity:</span>
                  <span
                    className={`font-mono font-semibold px-2 py-0.5 rounded-full ${
                      isExpired
                        ? "bg-rose-500/20 text-rose-300"
                        : secondsLeft < 120
                          ? "bg-amber-500/20 text-amber-300"
                          : "bg-cyan-500/20 text-cyan-200"
                    }`}
                  >
                    {isExpired ? "Expired" : formattedCountdown}
                  </span>
                  <button
                    onClick={generateFreshQR}
                    className="text-[11px] text-cyan-400 hover:underline ml-1"
                    title="Click to reset timer and generate new token"
                  >
                    Reset
                  </button>
                </div>
              </div>

              {/* Mode Details & Companion Connection Card */}
              <div className="mt-4 space-y-3 rounded-2xl bg-white/5 p-3.5 text-xs text-slate-200">
                {pairingMode === "cloud" ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-violet-300 flex items-center gap-1.5">
                        <span>☁️ Cloud Relay Active</span>
                      </span>
                      {isCloudRelayActive ? (
                        <span className="flex items-center gap-1 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300 border border-emerald-500/30">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
                          Companion Polling Live
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[11px] text-amber-300 border border-amber-500/30">
                          Waiting for Companion
                        </span>
                      )}
                    </div>

                    <p className="text-slate-300 text-[11px]">
                      Your phone sends movements to this Vercel relay; the companion app on your PC executes them. Both can be on <strong>different networks</strong> (mobile data, 4G/5G, work Wi-Fi, etc.).
                    </p>

                    {!isCloudRelayActive ? (
                      <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 p-3 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-violet-200 font-medium">To connect your PC companion:</p>
                          {isCompanionConnected ? (
                            <button
                              onClick={activateCloudRelay}
                              disabled={busy === "cloud_relay"}
                              className="rounded-lg bg-violet-500 px-3 py-1 font-semibold text-white hover:bg-violet-400 text-xs shadow"
                            >
                              {busy === "cloud_relay" ? "Connecting..." : "⚡ Activate Relay Now"}
                            </button>
                          ) : null}
                        </div>
                        <div className="flex items-center justify-between gap-2 bg-black/40 rounded-lg p-2 border border-white/10">
                          <code className="text-cyan-300 text-[11px] font-mono select-all truncate">
                            {companionCliCommand}
                          </code>
                          <button
                            onClick={handleCopyCliCommand}
                            className="shrink-0 text-xs text-slate-300 hover:text-white bg-white/10 px-2 py-0.5 rounded"
                          >
                            {copiedCmd ? "Copied! ✓" : "Copy"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-slate-300 text-[11px]">
                      ⚡ Direct Wi-Fi connects phone directly to <code>http://{effectiveHost}:{effectivePort}</code>. Both devices must be on the <strong>same Wi-Fi router</strong>.
                    </p>
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-white/10">
                      <label htmlFor="interface-select" className="text-slate-300 font-medium">
                        PC Local IP:
                      </label>
                      <div className="flex flex-1 max-w-xs items-center gap-2">
                        <select
                          id="interface-select"
                          value={selectedHost}
                          onChange={(e) => handleSelectInterface(e.target.value)}
                          className="w-full rounded-lg bg-black/60 px-2.5 py-1 text-xs text-white border border-white/20 outline-none focus:border-cyan-400"
                        >
                          {status?.hostIp && status.hostIp !== "Unavailable" ? (
                            <option value={status.hostIp}>Default: {status.hostIp} ({status.networkName || "Auto"})</option>
                          ) : null}
                          {interfaces.map((iface) => (
                            <option key={iface.address} value={iface.address}>
                              {iface.name}: {iface.address}
                            </option>
                          ))}
                          <option value="127.0.0.1">Loopback: 127.0.0.1</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                {/* Encoded URL Inspector Pill */}
                <div className="pt-2 border-t border-white/10 flex items-center justify-between gap-2">
                  <div className="truncate font-mono text-[11px] text-slate-400 max-w-[280px] sm:max-w-md">
                    {effectivePairingUrl}
                  </div>
                  <a
                    href={effectivePairingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-cyan-300 hover:text-cyan-200 underline text-[11px]"
                  >
                    Open remote ↗
                  </a>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <button
                onClick={generateFreshQR}
                className="glossy-button rounded-xl bg-cyan-500/20 px-3 py-2 text-xs font-medium text-cyan-100 hover:bg-cyan-500/30"
                disabled={busy.length > 0}
              >
                {busy === "generate_qr" ? "Generating..." : "Fresh QR"}
              </button>
              <button
                onClick={handleCopyLink}
                className="glossy-button rounded-xl bg-violet-500/20 px-3 py-2 text-xs font-medium text-violet-100 hover:bg-violet-500/30"
              >
                {copied ? "Copied! ✓" : "Copy Link"}
              </button>
              <button
                onClick={handleDownloadQR}
                className="glossy-button rounded-xl bg-emerald-500/20 px-3 py-2 text-xs font-medium text-emerald-100 hover:bg-emerald-500/30"
              >
                Download PNG
              </button>
              <button
                onClick={() => apiAction("/api/disconnect")}
                className="glossy-button rounded-xl bg-rose-500/20 px-3 py-2 text-xs font-medium text-rose-100 hover:bg-rose-500/30"
                disabled={busy.length > 0}
              >
                Disconnect
              </button>
            </div>
          </article>

          {/* Connection Details & Pairing Approval Section */}
          <aside className="glass-card gradient-border rounded-3xl p-6 flex flex-col justify-between">
            <div>
              <h3 className="text-lg font-semibold text-white">Connection Details</h3>
              <dl className="mt-4 space-y-3 text-sm text-slate-200">
                <div className="flex justify-between gap-3 border-b border-white/5 pb-2">
                  <dt className="text-slate-400">Desktop Companion</dt>
                  <dd className={isCompanionConnected || isCloudRelayActive ? "text-emerald-400 font-medium" : "text-amber-400"}>
                    {isCompanionConnected
                      ? "Running Locally"
                      : isCloudRelayActive
                        ? "Active via Cloud Relay"
                        : "Offline / Unreachable"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 border-b border-white/5 pb-2">
                  <dt className="text-slate-400">Cloud Relay</dt>
                  <dd className={isCloudRelayActive ? "text-violet-300 font-medium" : "text-slate-500"}>
                    {isCloudRelayActive ? "Polling Live ☁" : "Inactive"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 border-b border-white/5 pb-2">
                  <dt className="text-slate-400">Pairing Mode</dt>
                  <dd className="font-semibold text-cyan-300">
                    {pairingMode === "cloud" ? "Cloud (Cross-Network)" : "Direct Local Wi-Fi"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 border-b border-white/5 pb-2">
                  <dt className="text-slate-400">Connected Phone</dt>
                  <dd className="font-medium text-white">
                    {status?.connectedDevice?.deviceLabel ?? (relayServerMobileActive ? "Mobile Phone (Cloud)" : "None")}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 border-b border-white/5 pb-2">
                  <dt className="text-slate-400">Session Duration</dt>
                  <dd>{connectionDuration}</dd>
                </div>
                <div className="flex justify-between gap-3 border-b border-white/5 pb-2">
                  <dt className="text-slate-400">Latency</dt>
                  <dd>{pairingMode === "cloud" ? "~40-80 ms (Cloud)" : status?.latencyMs ? `${status.latencyMs} ms` : "—"}</dd>
                </div>
              </dl>

              {/* Pending Mobile Pairing Request Card (Direct Mode) */}
              {status?.pendingRequest ? (
                <div className="mt-5 rounded-2xl border border-amber-400/40 bg-amber-400/15 p-4 text-sm text-amber-100 animate-pulse">
                  <p className="font-semibold text-base">Incoming Mobile Request!</p>
                  <p className="mt-1 text-xs">Device: <strong>{status.pendingRequest.deviceLabel}</strong></p>
                  <p className="mt-0.5 text-[11px] text-amber-200/80">Approve this device to allow cursor control.</p>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => apiAction("/api/pairing/approve", { requestId: status.pendingRequest?.requestId })}
                      className="flex-1 rounded-xl bg-emerald-500 py-2 text-xs font-bold text-slate-950 hover:bg-emerald-400"
                      disabled={busy.length > 0}
                    >
                      Approve Control
                    </button>
                    <button
                      onClick={() => apiAction("/api/pairing/reject", { requestId: status.pendingRequest?.requestId })}
                      className="flex-1 rounded-xl bg-rose-500/30 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/40"
                      disabled={busy.length > 0}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ) : null}

              {status?.message ? (
                <p className="mt-5 rounded-xl bg-white/10 p-3 text-xs text-slate-300">{status.message}</p>
              ) : null}
            </div>

            {/* Quick Flow Instructions */}
            <div className="mt-6 rounded-2xl bg-white/5 p-4 text-xs text-slate-300 space-y-2">
              <p className="font-semibold text-white">How it works:</p>
              <ol className="list-decimal pl-4 space-y-1.5 text-slate-400 text-[11px]">
                <li>
                  <strong className="text-white">Cloud Mode:</strong> Works anywhere. Your phone and laptop can be on <strong>completely different networks</strong> (mobile data, different Wi-Fi).
                </li>
                <li>
                  <strong className="text-white">Start Companion:</strong> On your PC, run <code className="bg-black/30 px-1 rounded text-cyan-300">npm run companion:dev</code>.
                </li>
                <li>
                  <strong className="text-white">Scan QR:</strong> Point your smartphone camera at the QR code and tap the link to open the trackpad.
                </li>
                <li>
                  <strong className="text-white">Direct Wi-Fi:</strong> If both devices share the same Wi-Fi router, switch to Direct Wi-Fi for ultra-low latency.
                </li>
              </ol>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
