"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { defaultSettings, settingsSchema, type ControllerSettings } from "@/lib/control-protocol";

const companionBase = process.env.NEXT_PUBLIC_COMPANION_URL ?? "http://127.0.0.1:4850";
const storageKey = "mobile-as-cursor:settings";

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2 text-sm">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`h-7 w-12 rounded-full p-1 transition ${value ? "bg-emerald-400/50" : "bg-slate-600/60"}`}
      >
        <span className={`block h-5 w-5 rounded-full bg-white transition ${value ? "translate-x-5" : "translate-x-0"}`} />
      </button>
    </label>
  );
}

export default function SettingsPage() {
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
  const [savedAt, setSavedAt] = useState<string>("");


  const persist = async (nextSettings: ControllerSettings) => {
    setSettings(nextSettings);
    localStorage.setItem(storageKey, JSON.stringify(nextSettings));
    setSavedAt(new Date().toLocaleTimeString());
    await fetch(`${companionBase}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextSettings),
    }).catch(() => undefined);
  };

  return (
    <main className="futuristic-bg min-h-screen px-4 py-8 sm:px-7">
      <section className="glass-card gradient-border mx-auto w-full max-w-3xl rounded-3xl p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Settings</h1>
            <p className="text-sm text-slate-300">Personalize remote-control behavior</p>
          </div>
          <Link href="/dashboard" className="rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20">
            Back
          </Link>
        </div>

        <div className="space-y-3">
          <label className="block rounded-xl bg-white/5 p-3 text-sm">
            Sensitivity: <strong>{settings.sensitivity.toFixed(2)}x</strong>
            <input
              className="mt-2 w-full"
              type="range"
              min={0.1}
              max={4}
              step={0.05}
              value={settings.sensitivity}
              onChange={(e) => persist({ ...settings, sensitivity: Number(e.target.value) })}
            />
          </label>

          <label className="block rounded-xl bg-white/5 p-3 text-sm">
            Acceleration: <strong>{settings.acceleration.toFixed(2)}x</strong>
            <input
              className="mt-2 w-full"
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={settings.acceleration}
              onChange={(e) => persist({ ...settings, acceleration: Number(e.target.value) })}
            />
          </label>

          <label className="block rounded-xl bg-white/5 p-3 text-sm">
            Smoothing: <strong>{settings.smoothing.toFixed(2)}</strong>
            <input
              className="mt-2 w-full"
              type="range"
              min={0}
              max={0.95}
              step={0.05}
              value={settings.smoothing}
              onChange={(e) => persist({ ...settings, smoothing: Number(e.target.value) })}
            />
          </label>

          <Toggle label="Tap to click" value={settings.tapToClick} onChange={(v) => persist({ ...settings, tapToClick: v })} />
          <Toggle label="Double tap to double-click" value={settings.doubleTap} onChange={(v) => persist({ ...settings, doubleTap: v })} />
          <Toggle label="Two-finger scrolling" value={settings.twoFingerScroll} onChange={(v) => persist({ ...settings, twoFingerScroll: v })} />
          <Toggle label="Natural scroll direction" value={settings.naturalScroll} onChange={(v) => persist({ ...settings, naturalScroll: v })} />
          <Toggle label="Haptic feedback" value={settings.haptic} onChange={(v) => persist({ ...settings, haptic: v })} />
          <Toggle label="Drag lock" value={settings.dragLock} onChange={(v) => persist({ ...settings, dragLock: v })} />
          <Toggle label="Left-handed buttons" value={settings.leftHanded} onChange={(v) => persist({ ...settings, leftHanded: v })} />
          <Toggle label="Reduced motion UI" value={settings.reducedMotion} onChange={(v) => persist({ ...settings, reducedMotion: v })} />
        </div>

        <p className="mt-5 text-xs text-slate-400">Saved locally{savedAt ? ` at ${savedAt}` : ""}. Settings sync to companion when available.</p>
      </section>
    </main>
  );
}
