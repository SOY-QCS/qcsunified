import "server-only";
import { redirect } from "next/navigation";
import { isOps, type AppRole, type RoleGrant } from "@qcs/types";
import { supabaseServer } from "./supabase/server";

export interface StaffRole extends RoleGrant { city_code: string | null; hub_code: string | null }
export interface Staff {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  roles: StaffRole[];
  aal: "aal1" | "aal2" | null;
  hasMfa: boolean;
}

/** The signed-in staff member, or a redirect to /login. Non-ops users get null. */
export async function getStaff(): Promise<Staff | null> {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");

  // If 2FA is set up, a password alone is not enough.
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.nextLevel === "aal2" && aal.currentLevel !== "aal2") redirect("/login/mfa");

  const { data: account } = await sb.rpc("my_account");
  const roles = ((account?.roles ?? []) as StaffRole[]);
  if (!isOps(roles)) return null;
  return {
    id: user.id,
    name: account?.profile?.full_name || user.email || user.phone || "Staff",
    email: user.email ?? null,
    phone: user.phone ?? null,
    roles,
    aal: (aal?.currentLevel as Staff["aal"]) ?? null,
    hasMfa: aal?.nextLevel === "aal2",
  };
}

export async function requireRole(allowed: AppRole[]): Promise<Staff> {
  const staff = await getStaff();
  if (!staff || !staff.roles.some((r) => allowed.includes(r.role))) redirect("/");
  return staff;
}
