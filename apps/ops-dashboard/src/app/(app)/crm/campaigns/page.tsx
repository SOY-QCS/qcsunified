import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { has, myCities, when } from "@/lib/ops";
import { RpcButton } from "@/components/run";
import { CRM_ROLES, CrmTabs, one } from "../tabs";
import { CampaignForm, ScheduleButton, SegmentForm } from "./forms";

/** Segments + broadcast offers. Only people who ticked "send me offers" are ever messaged; every message has an opt-out. */
export default async function Campaigns() {
  const me = await requireRole([...CRM_ROLES]);
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const [{ data: segments }, { data: campaigns, error }] = await Promise.all([
    sb.from("segments").select("id, name, audience, filters, city_id, cities(name)").order("created_at", { ascending: false }),
    sb.from("campaigns").select("id, name, channels, title, message, wa_template, status, scheduled_at, recipients, messages, sent_at, created_at, segments(name), approver:profiles!campaigns_approved_by_fkey(full_name)")
      .order("created_at", { ascending: false }).limit(50),
  ]);
  const canPrepare = has(me, "super_admin", "city_admin", "support");
  const canSend = has(me, "super_admin", "city_admin");
  return (
    <>
      <h1>Campaigns</h1>
      <CrmTabs at="/crm/campaigns" />
      <p className="muted">Support prepares a campaign; a City Admin or Super Admin approves and sends it. SMS costs money per message — check the numbers before sending. WhatsApp offers need a template Meta has approved.</p>

      <h2>Campaigns</h2>
      {error && <p className="error">{error.message}</p>}
      <table>
        <thead><tr><th>Name</th><th>To</th><th>Channels</th><th>Message</th><th>Status</th><th>Reached</th><th></th></tr></thead>
        <tbody>
          {(campaigns ?? []).map((c) => (
            <tr key={c.id}>
              <td>{c.name}<div className="muted">{when(c.created_at)}</div></td>
              <td>{one(c.segments)?.name}</td>
              <td>{c.channels.join(", ")}{c.wa_template ? <div className="muted">template: {c.wa_template}</div> : null}</td>
              <td style={{ maxWidth: 320 }}><strong>{c.title}</strong><br />{c.message}</td>
              <td>{c.status}{c.scheduled_at && c.status !== "draft" ? <div className="muted">{when(c.scheduled_at)}{one(c.approver) ? ` · by ${one(c.approver)!.full_name}` : ""}</div> : null}</td>
              <td>{c.recipients} people<div className="muted">{c.messages} messages</div></td>
              <td>
                {c.status === "draft" && canSend && <ScheduleButton id={c.id} />}
                {["draft", "scheduled", "sending"].includes(c.status) && canPrepare && <RpcButton fn="cancel_campaign" args={{ p_id: c.id }} done="Cancelled" label="Cancel" kind="danger" confirm="Cancel this campaign? Messages not yet sent are dropped." />}
              </td>
            </tr>
          ))}
          {!campaigns?.length && <tr><td colSpan={7} className="muted">No campaigns yet.</td></tr>}
        </tbody>
      </table>
      {canPrepare && !!segments?.length && <div className="card" style={{ maxWidth: 720 }}><strong>New campaign</strong>
        <CampaignForm segments={(segments ?? []).map((s) => ({ id: s.id, name: `${s.name} (${s.audience}${one(s.cities) ? `, ${one(s.cities)!.name}` : ""})` }))} /></div>}

      <h2>Segments</h2>
      <table><tbody>
        {(segments ?? []).map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.audience}</td><td>{one(s.cities)?.name ?? "All cities"}</td><td className="muted">{describe(s.filters as Record<string, unknown>)}</td></tr>)}
        {!segments?.length && <tr><td className="muted">No segments yet. Make one below, then a campaign for it.</td></tr>}
      </tbody></table>
      {canPrepare && <div className="card" style={{ maxWidth: 720 }}><strong>New segment</strong>
        <SegmentForm cities={cities.map((c) => ({ id: c.id, name: c.name }))} allowAll={global} /></div>}
    </>
  );
}

function describe(f: Record<string, unknown>): string {
  const out: string[] = [];
  if (f.ordered_within_days) out.push(`ordered in last ${f.ordered_within_days} days`);
  if (f.inactive_days) out.push(`no order for ${f.inactive_days}+ days`);
  if (f.min_orders) out.push(`${f.min_orders}+ orders`);
  if (f.service) out.push(`used ${f.service}`);
  if (f.account_type) out.push(String(f.account_type));
  if (Array.isArray(f.stages) && f.stages.length) out.push(`stage: ${f.stages.join(", ")}`);
  if (Array.isArray(f.tags) && f.tags.length) out.push(`tags: ${f.tags.join(", ")}`);
  return out.join(" · ") || "everyone who opted in";
}
