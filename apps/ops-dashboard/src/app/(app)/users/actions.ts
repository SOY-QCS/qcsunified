"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AppRole, canGrant, roleAssignmentProblem } from "@qcs/types";
import { getStaff } from "@/lib/session";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase/server";

export interface FormState { ok: boolean; message: string }

const emptyToNull = (v: unknown) => (v === "" || v === undefined ? null : v);
const InviteSchema = z.object({
  email: z.email("Enter a valid email").transform((e) => e.trim().toLowerCase()),
  full_name: z.string().trim().min(2, "Enter their full name"),
  role: AppRole,
  city_id: z.preprocess(emptyToNull, z.uuid().nullable()),
  hub_id: z.preprocess(emptyToNull, z.uuid().nullable()),
});

/**
 * Invite a staff member by email (or give an existing account another role).
 * The invite email takes them to "choose a password". The role itself is saved with the
 * admin's own session, so the database's role rules (RLS) still decide what is allowed.
 */
export async function inviteStaff(_prev: FormState, form: FormData): Promise<FormState> {
  const staff = await getStaff();
  if (!staff) return { ok: false, message: "Not signed in as staff" };

  const parsed = InviteSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]!.message };
  const { email, full_name, role, city_id, hub_id } = parsed.data;

  const problem = roleAssignmentProblem(role, city_id, hub_id);
  if (problem) return { ok: false, message: problem };
  if (!canGrant(staff.roles, role, city_id)) {
    return { ok: false, message: "You can't give that role (City Admins can add field roles in their own city only)." };
  }

  const admin = supabaseAdmin();
  const { data: existing } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  let userId = existing?.id as string | undefined;
  let invited = false;

  if (!userId) {
    const h = await headers();
    const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name },
      redirectTo: `${origin}/auth/callback?next=/reset-password`,
    });
    if (error || !data.user) return { ok: false, message: `Could not send the invite: ${error?.message ?? "unknown error"}` };
    userId = data.user.id;
    invited = true;
    await admin.from("profiles").update({ full_name, invited_by: staff.id, city_id }).eq("id", userId);
  }

  const sb = await supabaseServer();
  const { error } = await sb.from("user_roles").insert({ user_id: userId, role, city_id, hub_id, granted_by: staff.id });
  if (error) {
    if (error.code === "23505") return { ok: false, message: "They already have that role." };
    return { ok: false, message: `Role not saved: ${error.message}` };
  }
  revalidatePath("/users");
  return { ok: true, message: invited ? `Invite sent to ${email}.` : `Role added to ${email}'s existing account.` };
}

export async function removeRole(form: FormData) {
  const staff = await getStaff();
  if (!staff) return;
  const id = String(form.get("id") ?? "");
  const sb = await supabaseServer();
  const { data: row } = await sb.from("user_roles").select("user_id, role").eq("id", id).maybeSingle();
  // Don't let a Super Admin lock themselves out.
  if (row && row.user_id === staff.id && row.role === "super_admin") return;
  await sb.from("user_roles").delete().eq("id", id);
  revalidatePath("/users");
}
