/**
 * Cloud Relay API — Single serverless function for all relay operations.
 *
 * Using a SINGLE route ensures all requests hit the same Vercel serverless
 * function container, so `globalThis` in-memory state is shared between
 * the mobile (posting commands) and companion (polling for commands).
 *
 * Actions:
 *  - create   : Companion creates a relay session
 *  - join     : Mobile joins a relay session
 *  - command  : Mobile pushes a control command (or batch)
 *  - poll     : Companion polls for queued commands
 *  - status   : Check relay session status
 *  - heartbeat: Keep session alive
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
        { ok: false, error: "session_not_found" },
        { status: 404, headers: corsHeaders },
      );
    }
    const companionActive =
      session.lastCompanionPoll > 0 && Date.now() - session.lastCompanionPoll < 12_000;
    const mobileActive =
      session.mobileJoinedAt !== null && Date.now() - session.lastMobileCommand < 30_000;

    return Response.json(
      {
        ok: true,
        token,
        companionActive,
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
      // Auto-create session if companion hasn't registered yet
      // (mobile scanned QR before companion completed first poll)
      session = {
        token,
        companionJoinedAt: 0,
        mobileJoinedAt: Date.now(),
        mobileDeviceLabel: (body.deviceLabel as string) || "Mobile Phone",
        commands: [],
        lastCompanionPoll: 0,
        lastMobileCommand: Date.now(),
        createdAt: Date.now(),
      };
      store.set(token, session);

      return Response.json(
        {
          ok: true,
          status: "waiting_for_companion",
          companionActive: false,
          message: "Waiting for desktop companion to connect...",
        },
        { headers: corsHeaders },
      );
    }

    session.mobileJoinedAt = Date.now();
    session.mobileDeviceLabel =
      (body.deviceLabel as string) || session.mobileDeviceLabel || "Mobile Phone";
    session.lastMobileCommand = Date.now();

    const companionActive =
      session.companionJoinedAt > 0 && Date.now() - session.lastCompanionPoll < 12_000;

    return Response.json(
      {
        ok: true,
        status: companionActive ? "connected" : "waiting_for_companion",
        companionActive,
        message: companionActive
          ? "Connected to desktop companion"
          : "Waiting for desktop companion to connect...",
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
      // Auto-create session to avoid dropping early commands
      session = {
        token,
        companionJoinedAt: 0,
        mobileJoinedAt: Date.now(),
        mobileDeviceLabel: "Mobile Phone",
        commands: [],
        lastCompanionPoll: 0,
        lastMobileCommand: Date.now(),
        createdAt: Date.now(),
      };
      store.set(token, session);
    }

    const command = body.command as Record<string, unknown> | undefined;
    const commands = body.commands as Array<Record<string, unknown>> | undefined;

    if (command) {
      session.commands.push(command as { type: string; [key: string]: unknown });
    }
    if (Array.isArray(commands)) {
      for (const cmd of commands) {
        session.commands.push(cmd as { type: string; [key: string]: unknown });
      }
    }

    session.lastMobileCommand = Date.now();

    // Cap queue to prevent memory growth (keep last 300 commands)
    if (session.commands.length > 300) {
      session.commands = session.commands.slice(-300);
    }

    const companionActive =
      session.lastCompanionPoll > 0 && Date.now() - session.lastCompanionPoll < 12_000;

    return Response.json(
      { ok: true, queued: session.commands.length, companionActive },
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
      // Create session on-the-fly for this token
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
    if (session.companionJoinedAt === 0) {
      session.companionJoinedAt = Date.now();
    }

    // Drain command queue
    const commands = [...session.commands];
    session.commands = [];

    const mobileActive =
      session.mobileJoinedAt !== null && Date.now() - session.lastMobileCommand < 30_000;

    return Response.json(
      {
        ok: true,
        commands,
        mobileConnected: mobileActive,
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
    if (!session) {
      return Response.json(
        { ok: false, error: "session_not_found", companionActive: false, mobileActive: false },
        { status: 404, headers: corsHeaders },
      );
    }

    const companionActive =
      session.lastCompanionPoll > 0 && Date.now() - session.lastCompanionPoll < 12_000;
    const mobileActive =
      session.mobileJoinedAt !== null && Date.now() - session.lastMobileCommand < 30_000;

    return Response.json(
      {
        ok: true,
        companionActive,
        mobileActive,
        mobileDeviceLabel: session.mobileDeviceLabel,
        queueLength: session.commands.length,
        sessionAge: Date.now() - session.createdAt,
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
    if (!session) {
      return Response.json(
        { ok: false, error: "session_not_found" },
        { status: 404, headers: corsHeaders },
      );
    }

    const role = body.role as string;
    if (role === "companion") {
      session.lastCompanionPoll = Date.now();
    } else {
      session.lastMobileCommand = Date.now();
    }

    return Response.json({ ok: true }, { headers: corsHeaders });
  }

  return Response.json(
    { ok: false, error: "unknown_action" },
    { status: 400, headers: corsHeaders },
  );
}
