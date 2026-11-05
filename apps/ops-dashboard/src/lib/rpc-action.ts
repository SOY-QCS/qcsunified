"use server";
import { revalidatePath } from "next/cache";
import { getStaff } from "./session";
import { supabaseServer } from "./supabase/server";

export interface Result { ok: boolean; message: string; data?: unknown }

/**
 * One server action for the dashboard's buttons. It calls a database function AS the signed-in staff member,
 * so the database decides who may do what (city, role) and writes the audit log. Only the functions listed
 * here can be called this way.
 */
const ALLOWED = new Set([
  "assign_trip", "reassign_trip", "unassign_trip", "split_trip", "merge_trips", "plan_trip", "start_dispatch",
  "set_rider_status", "review_rider_document", "set_vendor_controls", "save_zone", "save_city", "save_hub",
  "save_setting", "clear_city_setting", "decide_pod_override", "review_pod_flag", "review_vendor_kyc",
  "mark_labels_printed", "plan_last_mile", "open_bag", "seal_bag", "create_manifest", "add_bag_to_manifest", "dispatch_manifest", "arrive_manifest",
  "close_manifest", "adjust_stock", "set_hub_fulfilment_rates", "resend_delivery_code", "pack_order", "move_stock", "bill_storage",
  "create_rider_payout_batch", "create_vendor_cod_batch", "cancel_payout_batch", "release_payout_hold", "receive_cod_cash", "bank_hub_cash", "add_rider_adjustment",
  "reply_ticket", "update_ticket", "staff_open_ticket", "add_crm_note", "set_crm_profile", "save_lead", "move_lead", "handle_crm_alert",
  "save_report_subscription", "review_fraud_flag", "segment_preview", "save_segment", "save_campaign", "schedule_campaign", "cancel_campaign", "log_contact", "cs_message",
]);

export async function rpcAction(fn: string, args: Record<string, unknown>, done: string, revalidate = "/"): Promise<Result> {
  if (!ALLOWED.has(fn)) return { ok: false, message: "Not allowed" };
  if (!(await getStaff())) return { ok: false, message: "Not signed in" };
  const { data, error } = await (await supabaseServer()).rpc(fn, args);
  revalidatePath(revalidate, "layout");
  return error ? { ok: false, message: error.message } : { ok: true, message: done, data };
}

/** Rider pay and cash limit: plain column edits, guarded by the database (Admin or Finance only). */
export async function saveRiderMoney(rider: string, v: { commission_pct: number | null; cod_limit_ghs: number | null }): Promise<Result> {
  if (!(await getStaff())) return { ok: false, message: "Not signed in" };
  if (v.commission_pct != null && !(v.commission_pct >= 0 && v.commission_pct <= 100)) return { ok: false, message: "Commission must be 0–100%" };
  if (v.cod_limit_ghs != null && !(v.cod_limit_ghs > 0)) return { ok: false, message: "Cash limit must be above zero (leave empty for no limit)" };
  const { data, error } = await (await supabaseServer()).from("riders").update({
    commission_rate_bp: v.commission_pct == null ? null : Math.round(v.commission_pct * 100),
    cod_float_limit: v.cod_limit_ghs == null ? null : Math.round(v.cod_limit_ghs * 100),
  }).eq("id", rider).select("id");
  revalidatePath(`/riders/${rider}`);
  if (error) return { ok: false, message: error.message };
  return data?.length ? { ok: true, message: "Saved" } : { ok: false, message: "Not allowed" };
}
