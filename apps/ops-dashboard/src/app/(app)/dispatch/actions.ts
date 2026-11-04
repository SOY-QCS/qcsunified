"use server";
import { revalidatePath } from "next/cache";
import { getStaff } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";

export interface Result { ok: boolean; message: string }

/** Every action is a database function: it checks the dispatcher's city and writes the audit log itself. */
async function call(fn: string, args: Record<string, unknown>, done: string): Promise<Result> {
  if (!(await getStaff())) return { ok: false, message: "Not signed in" };
  const { error } = await (await supabaseServer()).rpc(fn, args);
  revalidatePath("/dispatch");
  return error ? { ok: false, message: error.message } : { ok: true, message: done };
}

export const assignTrip = async (trip: string, rider: string) => call("assign_trip", { p_trip: trip, p_rider: rider }, "Assigned. The rider sees it in the app now.");
export const restartDispatch = async (trip: string) => call("start_dispatch", { p_trip: trip }, "Offering to riders again.");
export const decideOverride = async (id: string, approve: boolean) => call("decide_pod_override", { p_override: id, p_approve: approve }, approve ? "Approved — the rider can mark it delivered." : "Refused — the rider must get the code or report a failed attempt.");
export const reviewDelivery = async (order: string, note: string) => call("review_pod_flag", { p_order: order, p_note: note }, "Marked as checked.");
