/**
 * Cloud Relay Client for the companion server.
 *
 * Supports dual-channel real-time cloud communication:
 * 1. Low-latency streaming via public pub/sub (sub-20ms instant delivery, zero-config)
 * 2. Vercel API relay polling (fallback)
 *
 * Allows the phone to be on ANY network (mobile 4G/5G data, different Wi-Fi, etc.)
 * and control the laptop smoothly without needing port forwarding or a shared LAN.
 */

import https from "node:https";
import http from "node:http";
import type { SocketInbound } from "./protocol";
import { socketInboundSchema } from "./protocol";

export type CloudRelayConfig = {
  relayUrl?: string;       // e.g. "https://your-app.vercel.app"
  token: string;           // Session token
  pollIntervalMs?: number; // How often to poll fallback (default: 60ms)
  onCommand: (cmd: SocketInbound) => void;
  onMobileConnected?: (deviceLabel: string) => void;
  onMobileDisconnected?: () => void;
  onError?: (error: Error) => void;
};

export class CloudRelayClient {
  private config: CloudRelayConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sseReq: http.ClientRequest | null = null;
  private running = false;
  private mobileWasConnected = false;
  private consecutiveErrors = 0;
  private readonly maxConsecutiveErrors = 30;
  private isRecreating = false;
  private lastCommandTime = 0;

  constructor(config: CloudRelayConfig) {
    this.config = config;
  }

  async start(): Promise<boolean> {
    this.running = true;
    this.consecutiveErrors = 0;

    // 1. Start Real-Time PubSub Stream (Instant sub-20ms latency)
    this.startStreamingChannel();

    // 2. Register with Vercel API relay if relayUrl is provided
    if (this.config.relayUrl) {
      await this.registerWithVercelRelay();
      const pollInterval = this.config.pollIntervalMs ?? 60;
      this.pollTimer = setInterval(() => void this.pollVercelRelay(), pollInterval);
    }

    // 3. Heartbeat every 4 seconds
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), 4000);

    return true;
  }

  stop() {
    this.running = false;
    if (this.sseReq) {
      try {
        this.sseReq.destroy();
      } catch {
        // ignore
      }
      this.sseReq = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── Real-Time PubSub Channel (Instant Cross-Network Delivery) ─────────────

  private getChannelTopic(): string {
    return `mac_relay_${this.config.token}`;
  }

  private startStreamingChannel() {
    if (!this.running) return;

    const topic = this.getChannelTopic();
    const url = `https://ntfy.sh/${topic}/json`;

    try {
      this.sseReq = https.get(url, (res) => {
        let buffer = "";

        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const data = JSON.parse(trimmed) as { event?: string; message?: string };
              if (data.event === "message" && data.message) {
                this.handleIncomingMessage(data.message);
              }
            } catch {
              // Ignore invalid JSON lines
            }
          }
        });

        res.on("end", () => {
          if (this.running) {
            // Reconnect stream on disconnect
            setTimeout(() => this.startStreamingChannel(), 1000);
          }
        });

        res.on("error", () => {
          if (this.running) {
            setTimeout(() => this.startStreamingChannel(), 2000);
          }
        });
      });

      this.sseReq.on("error", () => {
        if (this.running) {
          setTimeout(() => this.startStreamingChannel(), 2000);
        }
      });

      console.log(`[cloud-relay] ⚡ Real-time cloud channel active for token ${this.config.token.slice(0, 8)}...`);

      // Announce companion presence to channel
      this.publishToChannel({
        type: "companion_online",
        deviceLabel: "PC Desktop",
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn("[cloud-relay] Real-time channel init error:", err);
    }
  }

  private publishToChannel(payload: Record<string, unknown>) {
    const topic = this.getChannelTopic();
    try {
      const postReq = https.request(`https://ntfy.sh/${topic}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      postReq.write(JSON.stringify(payload));
      postReq.end();
    } catch {
      // Ignore background post errors
    }
  }

  private handleIncomingMessage(rawMessage: string) {
    try {
      const parsed = JSON.parse(rawMessage) as Record<string, unknown>;

      // Track mobile connection status
      if (parsed.type === "mobile_joined" || parsed.type === "pair_request") {
        if (!this.mobileWasConnected) {
          this.mobileWasConnected = true;
          const label = (parsed.deviceLabel as string) || "Mobile Phone";
          console.log(`[cloud-relay] 📱 Mobile connected: ${label}`);
          this.config.onMobileConnected?.(label);
        }
        return;
      }

      if (parsed.type === "mobile_heartbeat") {
        if (!this.mobileWasConnected) {
          this.mobileWasConnected = true;
          this.config.onMobileConnected?.("Mobile Phone");
        }
        return;
      }

      // Handle batch of commands
      if (Array.isArray(parsed.commands)) {
        for (const item of parsed.commands) {
          this.dispatchCommand(item);
        }
        return;
      }

      // Handle single command
      this.dispatchCommand(parsed);
    } catch {
      // Non-JSON message, ignore
    }
  }

  private dispatchCommand(raw: unknown) {
    try {
      const cmd = socketInboundSchema.parse(raw);
      if (cmd.type === "pair_request" || cmd.type === "heartbeat" || cmd.type === "disconnect") {
        return;
      }
      this.lastCommandTime = Date.now();
      if (!this.mobileWasConnected) {
        this.mobileWasConnected = true;
        this.config.onMobileConnected?.("Mobile Phone");
      }
      this.config.onCommand(cmd);
    } catch {
      // Skip invalid command silently
    }
  }

  // ─── Vercel API Relay Fallback ──────────────────────────────────────────────

  private async registerWithVercelRelay(): Promise<boolean> {
    if (!this.config.relayUrl) return false;
    const relayUrl = this.config.relayUrl.replace(/\/$/, "");

    try {
      const res = await fetch(`${relayUrl}/api/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          token: this.config.token,
        }),
      });

      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        console.log(`[cloud-relay] Session synced with Vercel relay: ${relayUrl}`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async recreateSession() {
    if (this.isRecreating || !this.running || !this.config.relayUrl) return;
    this.isRecreating = true;
    try {
      await this.registerWithVercelRelay();
      this.consecutiveErrors = 0;
    } catch {
      // Ignore
    } finally {
      this.isRecreating = false;
    }
  }

  private async pollVercelRelay() {
    if (!this.running || !this.config.relayUrl) return;

    const relayUrl = this.config.relayUrl.replace(/\/$/, "");

    try {
      const res = await fetch(`${relayUrl}/api/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "poll",
          token: this.config.token,
        }),
      });

      if (!res.ok) {
        if (res.status === 404) {
          void this.recreateSession();
          return;
        }
        return;
      }

      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        commands: Array<Record<string, unknown>>;
        mobileConnected: boolean;
        mobileDeviceLabel?: string;
      };

      if (!data.ok && data.error === "session_not_found") {
        void this.recreateSession();
        return;
      }

      // Execute any commands queued on Vercel
      if (data.commands && data.commands.length > 0) {
        for (const rawCmd of data.commands) {
          this.dispatchCommand(rawCmd);
        }
      }

      if (data.mobileConnected && !this.mobileWasConnected) {
        this.mobileWasConnected = true;
        this.config.onMobileConnected?.(data.mobileDeviceLabel || "Mobile Phone");
      }
    } catch {
      // Background poll failure is harmless since SSE stream is primary
    }
  }

  private async sendHeartbeat() {
    if (!this.running) return;

    // Announce heartbeat to pub/sub channel
    this.publishToChannel({
      type: "companion_heartbeat",
      timestamp: Date.now(),
    });

    // Also heartbeat Vercel relay if configured
    if (this.config.relayUrl) {
      const relayUrl = this.config.relayUrl.replace(/\/$/, "");
      try {
        await fetch(`${relayUrl}/api/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "heartbeat",
            token: this.config.token,
            role: "companion",
          }),
        });
      } catch {
        // Ignore heartbeat failure
      }
    }

    // Check if mobile has been idle for 40 seconds
    if (this.mobileWasConnected && Date.now() - this.lastCommandTime > 40_000) {
      this.mobileWasConnected = false;
      this.config.onMobileDisconnected?.();
    }
  }
}
