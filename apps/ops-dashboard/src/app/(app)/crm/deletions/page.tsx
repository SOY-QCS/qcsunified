import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { when } from "@/lib/ops";
import { CrmTabs } from "../tabs";
import { DeleteButton, LogRequest, RemoveLoginButton } from "./delete-button";

type Req = { id: string; name: string | null; phone: string | null; email: string | null; reason: string | null; requested_at: string; days_left: number; rider: boolean; blockers: string[]; stage: "waiting" | "login" };

/** People who asked (in the app) to delete their account. Must be done within 30 days (store rules and data-protection law). */
export default async function Deletions() {
  await requireRole(["super_admin", "support"]);
  const { data, error } = await (await supabaseServer()).rpc("account_deletion_list");
  const list = (data ?? []) as Req[];
  return (
    <>
      <h1>Account deletions</h1>
      <CrmTabs at="/crm/deletions" />
      <p className="muted" style={{ maxWidth: 760 }}>
        People ask in the app (Settings → Delete my account) or by contacting support. Settle anything owed first (wallet money is withdrawn to their MoMo,
        riders hand in COD cash, business accounts are closed with the owner), then delete within 30 days. Their name, phone, email, saved addresses and phone
        records are erased and they can no longer sign in; past orders and payments stay as &quot;Deleted account&quot; for our records.
      </p>
      <LogRequest />
      {error && <p className="error">{error.message}</p>}
      <table>
        <thead><tr><th>Person</th><th>Asked</th><th>Reason</th><th>Still to settle</th><th /></tr></thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id}>
              <td>{r.name || "—"}{r.rider ? " (rider)" : ""}<div className="muted">{r.phone}{r.email ? ` · ${r.email}` : ""}</div></td>
              <td>{when(r.requested_at)}<div><span style={{ whiteSpace: "nowrap" }} className={`sla ${r.days_left <= 5 ? "bad" : r.days_left <= 14 ? "warn" : "ok"}`}>{r.days_left} days left</span></div></td>
              <td>{r.reason ?? <span className="muted">—</span>}</td>
              <td>{r.stage === "login" ? <strong>Details erased — the login still has to be removed</strong> : r.blockers.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{r.blockers.map((b) => <li key={b}>{b}</li>)}</ul> : <span className="muted">Nothing — ready</span>}</td>
              <td>{r.stage === "login" ? <RemoveLoginButton id={r.id} /> : <DeleteButton id={r.id} blocked={r.blockers.length > 0} />}</td>
            </tr>
          ))}
          {!list.length && <tr><td colSpan={5} className="muted">No requests waiting.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
