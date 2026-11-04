import { errorResponse, serviceClient } from "@/server/supabase";

/** GET /api/v1/payments/QCS... — is this payment done? Shows only the state (the reference is random and unguessable). */
export async function GET(_req: Request, ctx: RouteContext<"/api/v1/payments/[ref]">) {
  try {
    const { ref } = await ctx.params;
    if (!/^QCS[0-9A-Z]{10,29}$/.test(ref)) return Response.json({ error: "Unknown payment" }, { status: 404 });
    const { data } = await serviceClient().from("payments").select("state, amount, purpose, paid_at").eq("client_reference", ref).maybeSingle();
    if (!data) return Response.json({ error: "Unknown payment" }, { status: 404 });
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
