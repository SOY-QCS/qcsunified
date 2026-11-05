import { serviceClient } from "@/server/supabase";
import { clientIp, limited } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — for an uptime checker (e.g. UptimeRobot, free): 200 when the portal and database answer and no
 * System-health check is red; 503 otherwise, with the names of the red checks. No customer data is ever returned.
 */
export async function GET(req: Request) {
  const stop = await limited("health", `ip:${clientIp(req)}`); if (stop) return stop;
  try {
    const { data, error } = await serviceClient().rpc("health_ping");
    if (error) throw new Error(error.message);
    const h = data as { ok: boolean; bad: string[]; at: string };
    return Response.json({ ok: h.ok, problems: h.bad, at: h.at }, { status: h.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ ok: false, problems: ["database"], detail: (e as Error).message.slice(0, 120) }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
