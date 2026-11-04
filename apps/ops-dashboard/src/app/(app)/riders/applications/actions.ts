"use server";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";

export interface ReviewState { ok: boolean; message: string }

/** Approve or reject a rider. The database checks the reviewer is Super Admin or that city's admin. */
export async function reviewRider(_prev: ReviewState, form: FormData): Promise<ReviewState> {
  const riderId = String(form.get("rider_id"));
  const approve = form.get("decision") === "approve";
  const note = String(form.get("note") ?? "").trim() || null;
  const riderType = String(form.get("rider_type") ?? "commission");
  const pct = Number(form.get("commission_pct") ?? 20);
  if (!approve && !note) return { ok: false, message: "Write the reason so the rider knows what to fix." };
  if (riderType === "commission" && (!Number.isFinite(pct) || pct < 0 || pct > 100)) return { ok: false, message: "Commission must be 0–100%." };

  const sb = await supabaseServer();
  const { error } = await sb.rpc("review_rider_application", {
    p_rider_id: riderId, p_approve: approve, p_note: note,
    p_rider_type: riderType, p_commission_rate_bp: riderType === "commission" ? Math.round(pct * 100) : null,
  });
  if (error) return { ok: false, message: error.message };
  revalidatePath("/riders/applications");
  return { ok: true, message: approve ? "Approved — the rider can now go online." : "Rejected — the rider will see your reason." };
}
