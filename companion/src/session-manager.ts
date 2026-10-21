import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

function getStoredOrNewToken(): string {
  if (process.env.COMPANION_TOKEN) {
    return process.env.COMPANION_TOKEN.trim().toUpperCase();
  }
  const tokenFile = path.resolve(process.cwd(), ".companion_token");
  try {
    if (fs.existsSync(tokenFile)) {
      const content = fs.readFileSync(tokenFile, "utf-8").trim().toUpperCase();
      if (content.length >= 4 && content.length <= 32) {
        return content;
      }
    }
  } catch {
    // ignore
  }
  const generated = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, "8");
  try {
    fs.writeFileSync(tokenFile, generated, "utf-8");
  } catch {
    // ignore
  }
  return generated;
}

export type PairingStatus = "Ready to Pair" | "Awaiting Approval" | "Connected" | "Disconnected" | "Connection Failed";

export type PendingRequest = {
  requestId: string;
  token: string;
  deviceLabel: string;
  requestedAt: number;
  socketId: string;
};

export type ActiveSession = {
  socketId: string;
  deviceLabel: string;
  connectedAt: number;
  token: string;
  lastHeartbeat: number;
};

export class SessionManager {
  private pairingToken: { value: string; expiresAt: number; consumed: boolean } | null = null;
  private pending: PendingRequest | null = null;
  private active: ActiveSession | null = null;
  private status: PairingStatus = "Disconnected";

  createToken(ttlMs = 24 * 60 * 60_000, customToken?: string): { token: string; expiresAt: number } {
    const defaultToken = getStoredOrNewToken();
    const token = customToken && customToken.trim().length > 0 ? customToken.trim().toUpperCase() : defaultToken;
    const expiresAt = Date.now() + ttlMs;
    this.pairingToken = { value: token, expiresAt, consumed: false };
    this.pending = null;
    if (!this.active) this.status = "Ready to Pair";

    // Also persist the chosen token
    try {
      const tokenFile = path.resolve(process.cwd(), ".companion_token");
      fs.writeFileSync(tokenFile, token, "utf-8");
    } catch {
      // ignore
    }

    return { token, expiresAt };
  }

  currentToken(): { value: string; expiresAt: number; consumed: boolean } {
    if (!this.pairingToken || Date.now() > this.pairingToken.expiresAt) {
      this.createToken();
    }
    return this.pairingToken!;
  }

  receivePairRequest(params: { token: string; deviceLabel: string; socketId: string }): { ok: boolean; reason?: string; request?: PendingRequest } {
    const token = this.currentToken();
    if (params.token.trim().toUpperCase() !== token.value.toUpperCase()) {
      return { ok: false, reason: "Invalid pairing token." };
    }

    const request: PendingRequest = {
      requestId: nanoid(12),
      token: params.token.trim().toUpperCase(),
      deviceLabel: params.deviceLabel,
      requestedAt: Date.now(),
      socketId: params.socketId,
    };
    this.pending = request;
    this.status = "Awaiting Approval";
    return { ok: true, request };
  }

  approve(requestId: string): ActiveSession | null {
    if (!this.pending || this.pending.requestId !== requestId) return null;
    const token = this.currentToken();
    token.consumed = true;

    this.active = {
      socketId: this.pending.socketId,
      deviceLabel: this.pending.deviceLabel,
      connectedAt: Date.now(),
      token: this.pending.token,
      lastHeartbeat: Date.now(),
    };
    this.pending = null;
    this.status = "Connected";
    return this.active;
  }

  reject(requestId: string): PendingRequest | null {
    if (!this.pending || this.pending.requestId !== requestId) return null;
    const rejected = this.pending;
    this.pending = null;
    this.status = "Ready to Pair";
    return rejected;
  }

  touchHeartbeat(socketId: string) {
    if (this.active && this.active.socketId === socketId) {
      this.active.lastHeartbeat = Date.now();
    }
  }

  disconnect(socketId?: string): ActiveSession | null {
    if (!this.active) return null;
    if (socketId && this.active.socketId !== socketId) return null;
    const previous = this.active;
    this.active = null;
    this.status = "Disconnected";
    return previous;
  }

  getStatus(): PairingStatus {
    return this.status;
  }

  getActive(): ActiveSession | null {
    return this.active;
  }

  getPending(): PendingRequest | null {
    return this.pending;
  }

  heartbeatTimedOut(timeoutMs = 15_000): boolean {
    if (!this.active) return false;
    return Date.now() - this.active.lastHeartbeat > timeoutMs;
  }
}
