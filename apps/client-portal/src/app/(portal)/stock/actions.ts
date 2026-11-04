"use server";
import { supabaseServer } from "@/lib/supabase/server";

/** Add or change a product; the database checks this person works for the vendor and fulfilment is on. */
export async function saveProduct(vendorId: string, id: string | null, p: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  const { error } = await (await supabaseServer()).rpc("save_sku", { p_id: id, p_vendor: vendorId, p });
  return error ? { ok: false, message: error.message } : { ok: true, message: "Saved" };
}
