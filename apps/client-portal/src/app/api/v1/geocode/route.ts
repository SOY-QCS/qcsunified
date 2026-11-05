import { z } from "zod";
import { geocode, hasGoogle } from "@/server/maps";
import { ApiError, caller, errorResponse } from "@/server/supabase";
import { limited } from "@/server/rate-limit";

const Body = z.object({ rows: z.array(z.object({ row: z.number(), address: z.string(), landmark: z.string().nullable().optional(), ghana_post_gps: z.string().nullable().optional() })).max(200) });

/** POST /api/v1/geocode — find pins for bulk-upload rows that have no latitude/longitude. */
export async function POST(req: Request) {
  try {
    const me = await caller(req);
    const stop = await limited("geocode", `user:${me.user.id}`); if (stop) return stop;
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) throw new ApiError(400, "Send up to 200 rows");
    if (!hasGoogle()) return Response.json({ results: parsed.data.rows.map((r) => ({ row: r.row, location: null })), available: false });
    const results = [];
    for (const r of parsed.data.rows) {
      const location = await geocode([r.address, r.landmark, "Ghana"].filter(Boolean).join(", "));
      results.push({ row: r.row, location });
    }
    return Response.json({ results, available: true });
  } catch (e) {
    return errorResponse(e);
  }
}
