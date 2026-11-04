"use client";
import { useActionState, useState } from "react";
import { GLOBAL_STAFF_ROLES, HUB_ROLES, ROLE_LABELS, type AppRole } from "@qcs/types";
import { inviteStaff, type FormState } from "./actions";

interface Opt { id: string; label: string; city_id?: string }

export function InviteForm({ roles, cities, hubs }: { roles: AppRole[]; cities: Opt[]; hubs: Opt[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(inviteStaff, { ok: false, message: "" });
  const [role, setRole] = useState<AppRole>(roles[0]!);
  const [city, setCity] = useState(cities.length === 1 ? cities[0]!.id : "");
  const global = GLOBAL_STAFF_ROLES.includes(role);

  return (
    <form action={action} className="card">
      <strong>Invite staff or add a role</strong>
      <p className="muted">New people get an email to choose their password. If they already have an account, the role is simply added.</p>
      <div className="row">
        <div><label htmlFor="full_name">Full name</label><input id="full_name" name="full_name" required /></div>
        <div><label htmlFor="email">Email</label><input id="email" name="email" type="email" required /></div>
      </div>
      <div className="row">
        <div>
          <label htmlFor="role">Role</label>
          <select id="role" name="role" value={role} onChange={(e) => setRole(e.target.value as AppRole)}>
            {roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="city_id">City</label>
          <select id="city_id" name="city_id" value={global ? "" : city} disabled={global} onChange={(e) => setCity(e.target.value)}>
            {global ? <option value="">All cities</option> : <option value="">Choose…</option>}
            {!global && cities.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        {HUB_ROLES.includes(role) && (
          <div>
            <label htmlFor="hub_id">Hub (optional)</label>
            <select id="hub_id" name="hub_id" defaultValue="">
              <option value="">All hubs in the city</option>
              {hubs.filter((h) => !city || h.city_id === city).map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
            </select>
          </div>
        )}
      </div>
      {state.message && <p className={state.ok ? "notice" : "error"} role="status">{state.message}</p>}
      <button className="btn" style={{ marginTop: 14 }} disabled={pending}>{pending ? "Saving…" : "Send invite / add role"}</button>
    </form>
  );
}
