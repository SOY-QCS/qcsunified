"use server";
import { revalidatePath } from "next/cache";
import { getStaff } from "@/lib/session";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase/server";
import type { Result } from "@/lib/rpc-action";

/**
 * Delete an account: first the database erases the personal details (it checks the staff member's role and that nothing
 * is owed either way), then the login is removed with the Supabase admin API ("soft delete": the login is wiped but its
 * id stays, so past orders keep pointing at "Deleted account").
 */
export async function deleteAccount(requestId: string, note: string): Promise<Result> {
  if (!(await getStaff())) return { ok: false, message: "Not signed in" };
  const { error } = await (await supabaseServer()).rpc("process_account_deletion", { p_request: requestId, p_note: note });
  if (error) { revalidatePath("/crm/deletions"); return { ok: false, message: error.message }; }
  return removeLogin(requestId);
}

/**
 * Step 2 (also the retry button): remove the login with the Supabase admin API, then record that it is gone.
 * Until then the request stays on the list as "login still to remove", so a failure is never lost.
 */
export async function removeLogin(requestId: string): Promise<Result> {
  if (!(await getStaff())) return { ok: false, message: "Not signed in" };
  const sb = await supabaseServer();
  const { data: row } = await sb.from("account_deletions").select("user_id, status").eq("id", requestId).maybeSingle();
  if (!row || row.status !== "done") return { ok: false, message: "Erase the details first" };
  try {
    const { error } = await supabaseAdmin().auth.admin.deleteUser(row.user_id as string, true);
    if (error && !/not found/i.test(error.message)) throw error;
  } catch (e) {
    revalidatePath("/crm/deletions");
    return { ok: false, message: `Details erased, but the login could not be removed yet (${(e as Error).message}). Press "Remove login" to try again.` };
  }
  const { error } = await sb.rpc("mark_login_removed", { p_request: requestId });
  revalidatePath("/crm/deletions");
  return error ? { ok: false, message: error.message } : { ok: true, message: "Account deleted" };
}

/** Log a request that came by WhatsApp, email or phone (after checking it is really the account holder). */
export async function logRequest(phone: string, how: string): Promise<Result> {
  if (!(await getStaff())) return { ok: false, message: "Not signed in" };
  const { error } = await (await supabaseServer()).rpc("staff_request_account_deletion", { p_phone: phone, p_reason: how });
  revalidatePath("/crm/deletions");
  return error ? { ok: false, message: error.message } : { ok: true, message: "Request logged" };
}
