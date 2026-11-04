"use client";
import { useState, useTransition } from "react";
import { saveChannels, saveTemplate, type Result } from "./actions";

const SAMPLE: Record<string, string> = {
  tracking_number: "ACC-202611041301-ACC", recipient_name: "Yaw Boateng", sender: "Kente Hub", rider_name: "Kofi", rider_plate: "GR-6061-24",
  track_url: "https://qcsghana.com/track/ACC-202611041301-ACC", confirm_url: "https://qcsghana.com/c/3f9a…", reason: "Recipient not available",
  code: "4821", hub_name: "Kumasi hub", status_text: "at hub", moved_km: "1.8", extra_ghs: "6.50", amount_ghs: "10.00", expires_in: "20",
  note: "", score: "2", comment: "Took very long",
};
const fill = (t: string) => t.replaceAll(/\{\{([a-z_]+)\}\}/g, (_, k: string) => SAMPLE[k] ?? "").replaceAll("\\n", "\n");

export interface Tpl { key: string; channel: string; audience: string; subject: string; body: string; wa_template: string | null; essential: boolean; enabled: boolean; description: string }

export function TemplateEditor({ t, canEdit }: { t: Tpl; canEdit: boolean }) {
  const [v, setV] = useState({ subject: t.subject, body: t.body, wa_template: t.wa_template ?? "", enabled: t.enabled });
  const [pending, start] = useTransition();
  const [r, setR] = useState<Result | null>(null);
  const sms = t.channel === "sms" ? fill(v.body).length : 0;
  return (
    <div className="card" style={{ opacity: v.enabled ? 1 : 0.6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong>{t.description} · {t.channel.toUpperCase()}</strong>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={v.enabled} disabled={!canEdit || t.essential} onChange={(e) => setV({ ...v, enabled: e.target.checked })} style={{ width: "auto" }} />
          {t.essential ? "Always on" : "On"}
        </label>
      </div>
      {(t.channel === "push" || t.channel === "email") && <><label>Title</label><input value={v.subject} disabled={!canEdit} onChange={(e) => setV({ ...v, subject: e.target.value })} /></>}
      <label>Message</label>
      <textarea rows={3} value={v.body} disabled={!canEdit} onChange={(e) => setV({ ...v, body: e.target.value })} style={{ width: "100%" }} />
      {t.channel === "whatsapp" && <><label>Meta template name</label><input value={v.wa_template} disabled={!canEdit} onChange={(e) => setV({ ...v, wa_template: e.target.value })} />
        <p className="muted">WhatsApp only delivers wording Meta has approved. If you change the text, submit the same text to Meta under this template name; each {"{{…}}"} becomes {"{{1}}"}, {"{{2}}"}… in order.</p></>}
      <p className="muted" style={{ whiteSpace: "pre-wrap" }}>Preview: {fill(v.body)}{sms ? `  (${sms} characters${sms > 160 ? ` = ${Math.ceil(sms / 153)} SMS` : ""})` : ""}</p>
      {canEdit && <button className="btn small" disabled={pending} onClick={() => start(async () => setR(await saveTemplate(t.key, t.channel, v)))}>Save</button>}
      {r && <p className={r.ok ? "notice" : "error"}>{r.message}</p>}
    </div>
  );
}

export function ChannelSettings({ channels, siteUrl, eta, canEdit }: { channels: string[]; siteUrl: string; eta: number; canEdit: boolean }) {
  const [c, setC] = useState(channels);
  const [url, setUrl] = useState(siteUrl);
  const [speed, setSpeed] = useState(String(eta));
  const [pending, start] = useTransition();
  const [r, setR] = useState<Result | null>(null);
  const toggle = (x: string) => setC((v) => (v.includes(x) ? v.filter((y) => y !== x) : [...v, x]));
  return (
    <div className="card">
      <strong>Recipients without an account</strong>
      <p className="muted">How we reach the person receiving the parcel. SMS works on every phone; WhatsApp is cheaper per message but needs Meta-approved templates. Choose both to send both.</p>
      {["sms", "whatsapp"].map((x) => <label key={x} style={{ display: "inline-flex", gap: 6, marginRight: 16 }}><input type="checkbox" style={{ width: "auto" }} disabled={!canEdit} checked={c.includes(x)} onChange={() => toggle(x)} />{x === "sms" ? "SMS" : "WhatsApp"}</label>)}
      <div className="row">
        <div><label>Website address in links</label><input value={url} disabled={!canEdit} onChange={(e) => setUrl(e.target.value)} /></div>
        <div><label>Average rider speed for arrival times (km/h)</label><input inputMode="numeric" value={speed} disabled={!canEdit} onChange={(e) => setSpeed(e.target.value)} /></div>
      </div>
      {canEdit && <button className="btn small" style={{ marginTop: 8 }} disabled={pending} onClick={() => start(async () => setR(await saveChannels(c, url, Number(speed))))}>Save</button>}
      {r && <p className={r.ok ? "notice" : "error"}>{r.message}</p>}
    </div>
  );
}
