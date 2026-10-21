/**
 * Cloud Relay Client for the companion server.
 *
 * When running in cloud relay mode, the companion polls
 * the Vercel-hosted relay API for commands from the mobile phone.
 * This allows the phone to be on a completely different network
 * (mobile 4G/5G data, different Wi-Fi, coffee shop, etc.)
 */

import type { SocketInbound } from "./protocol";
import { socketInboundSchema } from "./protocol";

export type CloudRelayConfig = {
  relayUrl: string;        // e.g. "https://your-app.vercel.app"
  token: string;           // Session token
  pollIntervalMs?: number; // How often to poll (default: 60ms)
  onCommand: (cmd: SocketInbound) => void;
  onMobileConnected?: (deviceLabel: string) => void;
  onMobileDisconnected?: () => void;
  onError?: (error: Error) => void;
};

export class CloudRelayClient {
  private config: CloudRelayConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private mobileWasConnected = false;
  private consecutiveErrors = 0;
  private readonly maxConsecutiveErrors = 25;
  private isRecreating = false;

  constructor(config: CloudRelayConfig) {
    this.config = config;
  }

  async start(): Promise<boolean> {
    const relayUrl = this.config.relayUrl.replace(/\/$/, "");

    // Register session with the relay
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
      if (!data.ok) {
        console.error(`[cloud-relay] Failed to create session on ${relayUrl}: ${data.error}`);
        return false;
      }

      console.log(`[cloud-relay] Session registered on cloud relay: ${relayUrl}`);
    } catch (err) {
      console.error("[cloud-relay] Cannot reach cloud relay server:", err);
      return false;
    }

    this.running = true;
    this.consecutiveErrors = 0;

    // Start polling for commands (60ms for low-latency cursor response)
    const pollInterval = this.config.pollIntervalMs ?? 60;
    this.pollTimer = setInterval(() => void this.poll(), pollInterval);

    // Heartbeat every 5 seconds
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 5000);

    return true;
  }

  stop() {
    this.running = false;
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

  private async recreateSession() {
    if (this.isRecreating || !this.running) return;
    this.isRecreating = true;
    const relayUrl = this.config.relayUrl.replace(/\/$/, "");

    try {
      console.log("[cloud-relay] Re-registering session on cloud relay...");
      await fetch(`${relayUrl}/api/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          token: this.config.token,
        }),
      });
      this.consecutiveErrors = 0;
    } catch {
      // Ignore
    } finally {
      this.isRecreating = false;
    }
  }

  private async poll() {
    if (!this.running) return;

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
          // Session expired or serverless instance recycled — self heal immediately
          void this.recreateSession();
          return;
        }

        this.consecutiveErrors++;
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          console.error("[cloud-relay] Too many consecutive errors, pausing cloud relay.");
          this.stop();
          this.config.onError?.(new Error("Cloud relay connection lost"));
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

      this.consecutiveErrors = 0;

      // Mobile connection state tracking
      if (data.mobileConnected && !this.mobileWasConnected) {
        this.mobileWasConnected = true;
        console.log(`[cloud-relay] 📱 Mobile device connected: ${data.mobileDeviceLabel || "Mobile Phone"}`);
        this.config.onMobileConnected?.(data.mobileDeviceLabel || "Mobile Phone (Cloud)");
      } else if (!data.mobileConnected && this.mobileWasConnected) {
        this.mobileWasConnected = false;
        console.log("[cloud-relay] Mobile disconnected");
        this.config.onMobileDisconnected?.();
      }

      // Execute queued commands
      if (data.commands && data.commands.length > 0) {
        for (const rawCmd of data.commands) {
          try {
            const cmd = socketInboundSchema.parse(rawCmd);
            this.config.onCommand(cmd);
          } catch {
            // Skip invalid commands silently
          }
        }
      }
    } catch {
      this.consecutiveErrors++;
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        console.error("[cloud-relay] Cloud relay unreachable, pausing.");
        this.stop();
        this.config.onError?.(new Error("Cloud relay connection lost"));
      }
    }
  }

  private async heartbeat() {
    if (!this.running) return;

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
      // Ignore heartbeat failures
    }
  }
}
