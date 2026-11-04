import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Vendors this person may book for (owner, or staff with "book" permission). RLS limits the rows to their own. */
export async function bookableVendorIds(db: SupabaseClient, userId: string): Promise<string[]> {
  const [{ data: owned }, { data: staff }] = await Promise.all([
    db.from("vendors").select("id").eq("owner_id", userId),
    db.from("vendor_staff").select("vendor_id, permissions").eq("user_id", userId).eq("is_active", true),
  ]);
  return [
    ...(owned ?? []).map((v) => v.id as string),
    ...(staff ?? []).filter((s) => (s.permissions as string[]).includes("book")).map((s) => s.vendor_id as string),
  ];
}
