import { CITY_ADMIN_GRANTABLE, INVITABLE_ROLES, OPS_ROLES, ROLE_LABELS, type AppRole } from "@qcs/types";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { InviteForm } from "./invite-form";
import { removeRole } from "./actions";

const STAFF_ROLES: AppRole[] = [...OPS_ROLES, "hub_handler"];

interface Row {
  id: string; role: AppRole; user_id: string; created_at: string;
  profile: { full_name: string; email: string | null; phone: string | null } | null;
  city: { code: string } | null; hub: { code: string } | null;
}

export default async function UsersPage() {
  const me = await requireRole(["super_admin", "city_admin"]);
  const isSuper = me.roles.some((r) => r.role === "super_admin");
  const myCities = me.roles.filter((r) => r.role === "city_admin").map((r) => r.city_id);
  const sb = await supabaseServer();

  const [{ data: rows }, { data: cities }, { data: hubs }] = await Promise.all([
    sb.from("user_roles")
      .select("id, role, user_id, created_at, profile:profiles!user_roles_user_id_fkey(full_name, email, phone), city:cities(code), hub:hubs(code)")
      .in("role", STAFF_ROLES).order("created_at", { ascending: false }),
    sb.from("cities").select("id, name").order("name"),
    sb.from("hubs").select("id, name, city_id").order("name"),
  ]);

  const cityOpts = (cities ?? []).filter((c) => isSuper || myCities.includes(c.id)).map((c) => ({ id: c.id, label: c.name }));
  const hubOpts = (hubs ?? []).map((h) => ({ id: h.id, label: h.name, city_id: h.city_id }));
  const grantable = isSuper ? INVITABLE_ROLES : INVITABLE_ROLES.filter((r) => CITY_ADMIN_GRANTABLE.includes(r));

  // one line per person
  const people = new Map<string, { profile: Row["profile"]; roles: Row[] }>();
  for (const r of (rows ?? []) as unknown as Row[]) {
    const p = people.get(r.user_id) ?? { profile: r.profile, roles: [] };
    p.roles.push(r);
    people.set(r.user_id, p);
  }

  return (
    <>
      <h1>Staff &amp; roles</h1>
      <InviteForm roles={grantable} cities={cityOpts} hubs={hubOpts} />
      <table>
        <thead><tr><th>Name</th><th>Contact</th><th>Roles</th></tr></thead>
        <tbody>
          {[...people.entries()].map(([uid, p]) => (
            <tr key={uid}>
              <td>{p.profile?.full_name || "—"}</td>
              <td>{p.profile?.email}<br /><span className="muted">{p.profile?.phone}</span></td>
              <td>
                {p.roles.map((r) => (
                  <form key={r.id} action={removeRole} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 8 }}>
                    <span className="tag">{ROLE_LABELS[r.role]}{r.city ? ` · ${r.city.code}` : ""}{r.hub ? ` · ${r.hub.code}` : ""}</span>
                    <input type="hidden" name="id" value={r.id} />
                    {!(uid === me.id && r.role === "super_admin") && <button className="btn danger small" title="Remove this role">✕</button>}
                  </form>
                ))}
              </td>
            </tr>
          ))}
          {people.size === 0 && <tr><td colSpan={3} className="muted">No staff yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
