"use client";
import { useState } from "react";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";

type Sub = { id: string; user_id: string; frequency: string; city_id: string | null; is_active: boolean; last_sent_at: string | null; who: string; email: string | null };
const when = (d: string | null) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "not yet");
const FREQ: Record<string, string> = { daily: "Daily (yesterday, every morning)", weekly: "Weekly (Mondays, last week)", monthly: "Monthly (the 1st, last month)" };

/** Email reports: sent at 06:15 Accra time to the person's email address. */
export function ReportSubscriptions({ meId, myEmail, isSuper, cities, allowAll, people, subs }: {
  meId: string; myEmail: string | null; isSuper: boolean; cities: { id: string; name: string }[]; allowAll: boolean; people: { id: string; name: string }[]; subs: Sub[];
}) {
  const [freq, setFreq] = useState("weekly");
  const [city, setCity] = useState(allowAll ? "" : cities[0]?.id ?? "");
  const [who, setWho] = useState(meId);
  const a = useRun();
  const cityName = (id: string | null) => (id ? cities.find((c) => c.id === id)?.name ?? "one city" : "All my cities");
  const save = (f: string, c: string | null, active: boolean, user: string) =>
    a.run(() => rpcAction("save_report_subscription", { p_frequency: f, p_city: c || null, p_active: active, p_user: user === meId ? null : user }, active ? "Report turned on" : "Report turned off"));
  return (
    <>
      <p>Get the main numbers by email: orders, success and on-time rates, revenue, failure reasons, top vendors and COD outstanding, with a link back to the charts.
        Sent at 06:15 (Accra) {myEmail ? <>to <strong>{myEmail}</strong></> : null}.</p>
      {!myEmail && <p className="error">Your account has no email address yet — ask a Super Admin to add one on the Staff page.</p>}
      <div className="card">
        <strong>Add an email report</strong>
        <div className="row" style={{ alignItems: "end" }}>
          {isSuper && people.length > 0 && <div><label>Send to</label><select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value={meId}>Me</option>{people.filter((p) => p.id !== meId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
          <div><label>How often</label><select value={freq} onChange={(e) => setFreq(e.target.value)}>{Object.entries(FREQ).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div><label>Cities</label><select value={city} onChange={(e) => setCity(e.target.value)}>
            {allowAll && <option value="">All cities</option>}{cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div style={{ flex: "0 0 auto" }}><button className="btn" disabled={a.pending} onClick={() => save(freq, city, true, who)}>Turn on</button></div>
        </div>
        <a.Msg />
      </div>
      <table>
        <thead><tr>{isSuper && <th>Person</th>}<th>Report</th><th>Cities</th><th>Last sent</th><th></th></tr></thead>
        <tbody>
          {subs.map((s) => (
            <tr key={s.id} style={{ opacity: s.is_active ? 1 : 0.55 }}>
              {isSuper && <td>{s.who}<div className="muted">{s.email}</div></td>}
              <td>{FREQ[s.frequency]}</td><td>{cityName(s.city_id)}</td><td>{when(s.last_sent_at)}</td>
              <td><button className="btn small secondary" disabled={a.pending} onClick={() => save(s.frequency, s.city_id ?? "", !s.is_active, s.user_id)}>{s.is_active ? "Turn off" : "Turn on"}</button></td>
            </tr>
          ))}
          {!subs.length && <tr><td colSpan={5} className="muted">No email reports yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
