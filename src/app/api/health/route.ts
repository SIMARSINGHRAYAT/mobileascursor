import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!db) {
    return Response.json({
      ok: true,
      status: "healthy",
      database: "not_configured",
    });
  }

  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, status: "healthy", database: "connected" });
  } catch (error) {
    return Response.json({ ok: false, status: "error", error: String(error) }, { status: 500 });
  }
}

