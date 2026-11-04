import { caller, errorResponse } from "@/server/supabase";

/** GET /api/v1/wallet?vendor_id= — balances, referral code and the latest movements. */
export async function GET(req: Request) {
  try {
    const me = await caller(req);
    const vendorId = new URL(req.url).searchParams.get("vendor_id");
    const { data: wallets, error } = await me.db.rpc("my_wallets");
    if (error) throw error;
    const { data: mine } = await me.db.from("wallets").select("id, owner_type, owner_id")
      .in("owner_type", vendorId ? ["vendor"] : ["customer", "customer_credit"]).eq("owner_id", vendorId ?? me.user.id);
    const ids = (mine ?? []).map((w) => w.id);
    const { data: entries } = ids.length
      ? await me.db.from("ledger_entries").select("amount, created_at, wallet_id, tx:ledger_transactions(kind, description)").in("wallet_id", ids)
          .order("created_at", { ascending: false }).limit(50)
      : { data: [] };
    const typeOf = new Map((mine ?? []).map((w) => [w.id, w.owner_type]));
    return Response.json({
      ...wallets,
      entries: (entries ?? []).map((e) => {
        const tx = (Array.isArray(e.tx) ? e.tx[0] : e.tx) as { kind: string; description: string } | null;
        return { at: e.created_at, amount: e.amount, wallet: typeOf.get(e.wallet_id), kind: tx?.kind, description: tx?.description };
      }),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
