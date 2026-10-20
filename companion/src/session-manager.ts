import { nanoid } from "nanoid";

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

  createToken(ttlMs = 15 * 60_000, customToken?: string): { token: string; expiresAt: number } {
    const token = customToken && customToken.trim().length > 0 ? customToken.trim() : nanoid(32);
    const expiresAt = Date.now() + ttlMs;
    this.pairingToken = { value: token, expiresAt, consumed: false };
    this.pending = null;
    if (!this.active) this.status = "Ready to Pair";
    return { token, expiresAt };
  }


  currentToken(): { value: string; expiresAt: number; consumed: boolean } | null {
    if (!this.pairingToken) return null;
    if (Date.now() > this.pairingToken.expiresAt) {
      this.pairingToken = null;
      if (!this.active) this.status = "Disconnected";
      return null;
    }
    return this.pairingToken;
  }

  receivePairRequest(params: { token: string; deviceLabel: string; socketId: string }): { ok: boolean; reason?: string; request?: PendingRequest } {
    if (this.active) return { ok: false, reason: "A device is already connected." };
    const token = this.currentToken();
    if (!token) return { ok: false, reason: "Pairing token expired. Request a fresh QR code." };
    if (token.consumed) return { ok: false, reason: "Token already used." };
    if (params.token !== token.value) return { ok: false, reason: "Invalid pairing token." };

    const request: PendingRequest = {
      requestId: nanoid(12),
      token: params.token,
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
    this.active = {
      socketId: this.pending.socketId,
      deviceLabel: this.pending.deviceLabel,
      connectedAt: Date.now(),
      token: this.pending.token,
      lastHeartbeat: Date.now(),
    };

    if (this.pairingToken) {
      this.pairingToken.consumed = true;
    }

    this.pending = null;
    this.status = "Connected";
    return this.active;
  }

  reject(requestId: string): PendingRequest | null {
    if (!this.pending || this.pending.requestId !== requestId) return null;
    const req = this.pending;
    this.pending = null;
    this.status = "Ready to Pair";
    return req;
  }

  touchHeartbeat(socketId: string): boolean {
    if (!this.active || this.active.socketId !== socketId) return false;
    this.active.lastHeartbeat = Date.now();
    return true;
  }

  isAuthorizedSocket(socketId: string): boolean {
    return this.active?.socketId === socketId;
  }

  disconnect(socketId?: string): ActiveSession | null {
    if (!this.active) {
      this.status = this.pending ? "Awaiting Approval" : "Disconnected";
      return null;
    }
    if (socketId && this.active.socketId !== socketId) return null;
    const old = this.active;
    this.active = null;
    this.pending = null;
    this.status = "Disconnected";
    return old;
  }

  heartbeatTimedOut(timeoutMs = 8_000): boolean {
    if (!this.active) return false;
    return Date.now() - this.active.lastHeartbeat > timeoutMs;
  }

  getStatus(): PairingStatus {
    const token = this.currentToken();
    if (!token && !this.active && !this.pending) {
      return this.status === "Connection Failed" ? "Connection Failed" : "Disconnected";
    }
    if (this.active) return "Connected";
    if (this.pending) return "Awaiting Approval";
    if (token) return "Ready to Pair";
    return this.status;
  }

  setFailure(): void {
    this.status = "Connection Failed";
  }

  getPending(): PendingRequest | null {
    return this.pending;
  }

  getActive(): ActiveSession | null {
    return this.active;
  }
}
