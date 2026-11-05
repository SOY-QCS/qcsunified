import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ctx } from "./core";

/** Context for bookings made by an integration on a business's behalf (no API key involved; always live). */
export async function vendorCtx(db: SupabaseClient, vendorId: string, source: Ctx["source"]): Promise<(Ctx & { verified: boolean }) | null> {
  const { data: v } = await db.from("vendors").select("id, owner_id, account_type, default_pickup_address_id, business_name, kyc_status").eq("id", vendorId).maybeSingle();
  if (!v?.owner_id) return null;
  return { vendorId: v.id, mode: "live", ownerId: v.owner_id, accountType: v.account_type, defaultPickupId: v.default_pickup_address_id,
           businessName: v.business_name, source, verified: v.kyc_status === "approved" };
}
