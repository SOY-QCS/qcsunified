import { supabaseServer } from "@/lib/supabase/server";

/** GET /api/live?city= — riders + active orders for the live map (the database limits it to the viewer's cities). */
export async function GET(req: Request) {
  const city = new URL(req.url).searchParams.get("city") || null;
  const { data, error } = await (await supabaseServer()).rpc("ops_live_map", { p_city: city });
  if (error) return Response.json({ error: error.message }, { status: 403 });
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
