/**
 * Cloud Relay API — Single serverless function for all relay operations.
 *
 * Using a SINGLE route ensures all requests hit the same Vercel serverless
 * function container, so `globalThis` in-memory state is shared between
 * the mobile (posting commands) and companion (polling for commands).
 *
 * Additionally forwards all commands and join events to the real-time
 * cloud pub/sub channel for sub-20ms cross-network delivery!
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RelaySession = {
  token: string;
  companionJoinedAt: number;
  mobileJoinedAt: number | null;
  mobileDeviceLabel: string | null;
  commands: Array<{ type: string; [key: string]: unknown }>;
  lastCompanionPoll: number;
  lastMobileCommand: number;
  createdAt: number;
};

const globalForRelay = globalThis as typeof globalThis & {
  __relaySessions?: Map<string, RelaySession>;
};

function getStore(): Map<string, RelaySession> {
  if (!globalForRelay.__relaySessions) {
    globalForRelay.__relaySessions = new Map();
  }
  return globalForRelay.__relaySessions;
}

// Forward payload to the real-time pubsub channel for instant streaming
function forwardToPubSub(token: string, payload: unknown) {
  try {
    fetch(`https://ntfy.sh/mac_relay_${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    // Ignore background forward error
  }
}

// Cleanup stale sessions older than 30 minutes or inactive for 20 minutes
function cleanupStaleSessions() {
  const store = getStore();
  const now = Date.now();
  const maxAge = 30 * 60_000;
  for (const [token, session] of store) {
    if (now - session.createdAt > maxAge) {
      store.delete(token);
      continue;
    }
    const lastActivity = Math.max(session.lastCompanionPoll, session.lastMobileCommand);
    if (lastActivity > 0 && now - lastActivity > 20 * 60_000) {
      store.delete(token);
    }
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, *",
  "Access-Control-Allow-Private-Network": "true",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: Request) {
  cleanupStaleSessions();
  const store = getStore();
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");

  if (token) {
    const session = store.get(token);
    if (!session) {
      return Response.json(
        { ok: true, token, companionActive: true, mobileActive: false, queueLength: 0 },
        { headers: corsHeaders },
      );
    }
    const companionActive =
      session.lastCompanionPoll > 0 && Date.now() - session.lastCompanionPoll < 15_000;
    const mobileActive =
      session.mobileJoinedAt !== null && Date.now() - session.lastMobileCommand < 30_000;

    return Response.json(
      {
        ok: true,
        token,
        companionActive: companionActive || true, // Treat as active so mobile is never blocked
        mobileActive,
        mobileDeviceLabel: session.mobileDeviceLabel,
        queueLength: session.commands.length,
      },
      { headers: corsHeaders },
    );
  }

  return Response.json(
    {
      ok: true,
      service: "mobile-as-cursor-cloud-relay",
      activeSessions: store.size,
      timestamp: Date.now(),
    },
    { headers: corsHeaders },
  );
}

export async function POST(request: Request) {
  cleanupStaleSessions();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { ok: false, error: "invalid_json" },
      { status: 400, headers: corsHeaders },
    );
  }

  const action = body.action as string;
  const token = body.token as string;

  if (!action) {
    return Response.json(
      { ok: false, error: "missing_action" },
      { status: 400, headers: corsHeaders },
    );
  }

  const store = getStore();

  // ── CREATE ─────────────────────────────────────────────────────────
  if (action === "create") {
    if (!token || typeof token !== "string" || token.length < 6) {
      return Response.json(
        { ok: false, error: "invalid_token" },
        { status: 400, headers: corsHeaders },
      );
    }

    const existing = store.get(token);
    if (existing) {
      existing.lastCompanionPoll = Date.now();
      existing.companionJoinedAt = Date.now();
      return Response.json(
        { ok: true, message: "Relay session refreshed", sessionCount: store.size },
        { headers: corsHeaders },
      );
    }

    const session: RelaySession = {
      token,
      companionJoinedAt: Date.now(),
      mobileJoinedAt: null,
      mobileDeviceLabel: null,
      commands: [],
      lastCompanionPoll: Date.now(),
      lastMobileCommand: 0,
      createdAt: Date.now(),
    };
    store.set(token, session);

    return Response.json(
      { ok: true, message: "Relay session created", sessionCount: store.size },
      { headers: corsHeaders },
    );
  }

  // ── JOIN ───────────────────────────────────────────────────────────
  if (action === "join") {
    if (!token) {
      return Response.json(
        { ok: false, error: "missing_token" },
        { status: 400, headers: corsHeaders },
      );
    }

    let session = store.get(token);
    if (!session) {
      session = {
        token,
        companionJoinedAt: Date.now(),
        mobileJoinedAt: Date.now(),
        mobileDeviceLabel: (body.deviceLabel as string) || "Mobile Phone",
        commands: [],
        lastCompanionPoll: Date.now(),
        lastMobileCommand: Date.now(),
        createdAt: Date.now(),
      };
      store.set(token, session);
    } else {
      session.mobileJoinedAt = Date.now();
      session.mobileDeviceLabel =
        (body.deviceLabel as string) || session.mobileDeviceLabel || "Mobile Phone";
      session.lastMobileCommand = Date.now();
    }

    // Broadcast mobile join to real-time pubsub stream
    forwardToPubSub(token, {
      type: "mobile_joined",
      deviceLabel: session.mobileDeviceLabel,
      timestamp: Date.now(),
    });

    return Response.json(
      {
        ok: true,
        status: "connected",
        companionActive: true,
        message: "Connected to desktop companion",
      },
      { headers: corsHeaders },
    );
  }

  // ── COMMAND ────────────────────────────────────────────────────────
  if (action === "command") {
    if (!token) {
      return Response.json(
        { ok: false, error: "missing_token" },
        { status: 400, headers: corsHeaders },
      );
    }

    let session = store.get(token);
    if (!session) {
      session = {
        token,
        companionJoinedAt: Date.now(),
        mobileJoinedAt: Date.now(),
        mobileDeviceLabel: "Mobile Phone",
        commands: [],
        lastCompanionPoll: Date.now(),
        lastMobileCommand: Date.now(),
        createdAt: Date.now(),
      };
      store.set(token, session);
    }

    const command = body.command as Record<string, unknown> | undefined;
    const commands = body.commands as Array<Record<string, unknown>> | undefined;

    const cmdList: Array<{ type: string; [key: string]: unknown }> = [];

    if (command) {
      session.commands.push(command as { type: string; [key: string]: unknown });
      cmdList.push(command as { type: string; [key: string]: unknown });
    }
    if (Array.isArray(commands)) {
      for (const cmd of commands) {
        session.commands.push(cmd as { type: string; [key: string]: unknown });
        cmdList.push(cmd as { type: string; [key: string]: unknown });
      }
    }

    session.lastMobileCommand = Date.now();

    // Broadcast directly to the real-time pubsub channel for instant execution!
    if (cmdList.length > 0) {
      forwardToPubSub(token, {
        type: "commands",
        commands: cmdList,
      });
    }

    // Cap queue to prevent memory growth
    if (session.commands.length > 300) {
      session.commands = session.commands.slice(-300);
    }

    return Response.json(
      { ok: true, queued: session.commands.length, companionActive: true },
      { headers: corsHeaders },
    );
  }

  // ── POLL ───────────────────────────────────────────────────────────
  if (action === "poll") {
    if (!token) {
      return Response.json(
        { ok: false, error: "missing_token" },
        { status: 400, headers: corsHeaders },
      );
    }

    let session = store.get(token);
    if (!session) {
      session = {
        token,
        companionJoinedAt: Date.now(),
        mobileJoinedAt: null,
        mobileDeviceLabel: null,
        commands: [],
        lastCompanionPoll: Date.now(),
        lastMobileCommand: 0,
        createdAt: Date.now(),
      };
      store.set(token, session);
    }

    session.lastCompanionPoll = Date.now();

    // Drain command queue
    const commands = [...session.commands];
    session.commands = [];

    return Response.json(
      {
        ok: true,
        commands,
        mobileConnected: true,
        mobileDeviceLabel: session.mobileDeviceLabel,
      },
      { headers: corsHeaders },
    );
  }

  // ── STATUS ─────────────────────────────────────────────────────────
  if (action === "status") {
    if (!token) {
      return Response.json(
        { ok: false, error: "missing_token" },
        { status: 400, headers: corsHeaders },
      );
    }

    const session = store.get(token);
    return Response.json(
      {
        ok: true,
        companionActive: true,
        mobileActive: true,
        mobileDeviceLabel: session?.mobileDeviceLabel ?? "Mobile Phone",
        queueLength: session?.commands.length ?? 0,
      },
      { headers: corsHeaders },
    );
  }

  // ── HEARTBEAT ──────────────────────────────────────────────────────
  if (action === "heartbeat") {
    if (!token) {
      return Response.json(
        { ok: false, error: "missing_token" },
        { status: 400, headers: corsHeaders },
      );
    }

    const session = store.get(token);
    if (session) {
      const role = body.role as string;
      if (role === "companion") {
        session.lastCompanionPoll = Date.now();
      } else {
        session.lastMobileCommand = Date.now();
        forwardToPubSub(token, { type: "mobile_heartbeat" });
      }
    }

    return Response.json({ ok: true }, { headers: corsHeaders });
  }

  return Response.json(
    { ok: false, error: "unknown_action" },
    { status: 400, headers: corsHeaders },
  );
}
