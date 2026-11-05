import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { when } from "@/lib/ops";

type Check = { key: string; label: string; status: "ok" | "warn" | "bad"; value: string | number; detail?: string | null; link?: string };
type Alert = { key: string; status: string; first_bad_at: string | null; last_alert_at: string | null; resolved_at: string | null };
const COLOR = { ok: "#1f8a4c", warn: "#c98a00", bad: "#c62828" } as const;
const WORD = { ok: "OK", warn: "Check", bad: "Problem" } as const;

/** Is anything quietly broken? Red checks are also emailed to Super Admins (every 3 hours until fixed). */
export default async function Health() {
  await requireRole(["super_admin", "city_admin", "finance", "dispatcher"]);
  const { data, error } = await (await supabaseServer()).rpc("system_health");
  const h = data as { checked_at: string; checks: Check[]; bad: number; warn: number; alerts: Alert[] } | null;
  const since = (key: string) => h?.alerts.find((a) => a.key === key && a.status === "bad")?.first_bad_at;
  return (
    <>
      <h1>System health</h1>
      {error && <p className="error">{error.message}</p>}
      {h && (
        <>
          <p style={{ fontSize: 18, margin: "0 0 4px" }}>
            {h.bad ? <strong style={{ color: COLOR.bad }}>{h.bad} problem{h.bad > 1 ? "s need" : " needs"} attention</strong>
              : h.warn ? <strong style={{ color: COLOR.warn }}>Working, {h.warn} thing{h.warn > 1 ? "s" : ""} to check</strong>
              : <strong style={{ color: COLOR.ok }}>Everything is working</strong>}
          </p>
          <p className="muted" style={{ marginTop: 0 }}>Checked {when(h.checked_at)}. Reload to check again. Red problems are emailed to Super Admins every 3 hours until fixed; an outside uptime checker watches the websites themselves (docs/go-live.md).</p>
          <table>
            <thead><tr><th /><th>Check</th><th>Now</th><th>What it means</th></tr></thead>
            <tbody>
              {h.checks.map((c) => (
                <tr key={c.key}>
                  <td><span className="tag" style={{ background: COLOR[c.status], color: "#fff", whiteSpace: "nowrap" }}>{WORD[c.status]}</span></td>
                  <td>{c.link ? <Link href={c.link}>{c.label}</Link> : c.label}{since(c.key) && <div className="muted">since {when(since(c.key)!)}</div>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{String(c.value)}</td>
                  <td>{c.detail ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
