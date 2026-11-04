import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ChannelSettings, TemplateEditor, type Tpl } from "./editors";

const GROUPS = [
  { audience: "sender", title: "To the person or business who booked" },
  { audience: "recipient", title: "To the recipient" },
  { audience: "rider", title: "To riders" },
  { audience: "staff", title: "To QCS staff" },
  { audience: "any", title: "Other" },
];
const when = (d: string) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", dateStyle: "short", timeStyle: "short" });

/** Message wording per event and channel, recipient channels, and what went out recently. */
export default async function Notifications() {
  const me = await requireRole(["super_admin", "city_admin", "support"]);
  const canEdit = me.roles.some((r) => r.role === "super_admin");
  const sb = await supabaseServer();
  const [{ data: templates }, { data: settings }, { data: recent }, { count: failed }] = await Promise.all([
    sb.from("notification_templates").select("*").order("key").order("channel"),
    sb.from("app_settings").select("key, value").in("key", ["recipient_channels", "public_site_url", "eta_speed_kmh"]).is("city_id", null),
    sb.from("notifications").select("id, template, channel, status, error, to_address, created_at, sent_at").order("created_at", { ascending: false }).limit(40),
    sb.from("notifications").select("id", { count: "exact", head: true }).eq("status", "failed").gte("created_at", new Date(Date.now() - 86_400_000).toISOString()),
  ]);
  const set = Object.fromEntries((settings ?? []).map((s) => [s.key, s.value]));
  return (
    <>
      <h1>Messages</h1>
      <p className="muted">Words in {"{{double braces}}"} are filled in automatically (tracking number, rider name, links…). {canEdit ? "" : "Only a Super Admin can change messages."}</p>
      <ChannelSettings channels={(set.recipient_channels as string[]) ?? ["sms"]} siteUrl={String(set.public_site_url ?? "")} eta={Number(set.eta_speed_kmh ?? 20)} canEdit={canEdit} />

      {GROUPS.map((g) => {
        const list = (templates ?? []).filter((t) => t.audience === g.audience) as Tpl[];
        return list.length ? <section key={g.audience}><h2>{g.title}</h2>{list.map((t) => <TemplateEditor key={`${t.key}-${t.channel}`} t={t} canEdit={canEdit} />)}</section> : null;
      })}

      <h2>Recently sent {failed ? <span className="error" style={{ fontSize: 14 }}> · {failed} failed in the last 24 h</span> : null}</h2>
      <table>
        <thead><tr><th>Queued</th><th>Message</th><th>Channel</th><th>Status</th></tr></thead>
        <tbody>
          {(recent ?? []).map((n) => (
            <tr key={n.id} className={n.status === "failed" ? "bad" : undefined}>
              <td>{when(n.created_at)}</td><td>{n.template}</td><td>{n.channel}</td>
              <td>{n.status}{n.error ? <><br /><span className="muted">{n.error}</span></> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
