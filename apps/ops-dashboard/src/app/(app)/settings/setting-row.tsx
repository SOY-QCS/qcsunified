"use client";
import { useState } from "react";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
function parse(text: string, like: unknown): unknown {
  if (typeof like === "number") { const n = Number(text); if (!Number.isFinite(n)) throw new Error("Type a number"); return n; }
  if (typeof like === "boolean") return text === "true";
  if (typeof like === "string") return text;
  return JSON.parse(text);   // lists / groups of values, e.g. {"fleet_pickup_fee": 500}
}

export function SettingRow({ k, description, value, cities, canDefault }: { k: string; description: string; value: unknown; cities: { id: string; value: unknown }[]; canDefault: boolean }) {
  return (
    <tr>
      <td><strong>{k.replaceAll("_", " ")}</strong><br /><span className="muted">{description}</span></td>
      <td><Cell k={k} city={null} value={value} like={value} enabled={canDefault} /></td>
      {cities.map((c) => <td key={c.id}><Cell k={k} city={c.id} value={c.value} like={value} enabled /></td>)}
    </tr>
  );
}

function Cell({ k, city, value, like, enabled }: { k: string; city: string | null; value: unknown; like: unknown; enabled: boolean }) {
  const [text, setText] = useState(value == null ? "" : show(value));
  const [err, setErr] = useState<string | null>(null);
  const a = useRun();
  const dirty = text !== (value == null ? "" : show(value));
  const save = () => {
    setErr(null);
    if (city && text.trim() === "") return a.run(() => rpcAction("clear_city_setting", { p_key: k, p_city: city }, "Uses the default again"));
    let v: unknown;
    try { v = parse(text, like); } catch (e) { return setErr((e as Error).message || "Not valid"); }
    a.run(() => rpcAction("save_setting", { p_key: k, p_city: city, p_value: v }, "Saved"));
  };
  if (!enabled) return <code>{show(value)}</code>;
  return (
    <div style={{ minWidth: 120 }}>
      {typeof like === "boolean"
        ? <select value={text} onChange={(e) => setText(e.target.value)}>{city && <option value="">(default)</option>}<option value="true">yes</option><option value="false">no</option></select>
        : <input value={text} onChange={(e) => setText(e.target.value)} placeholder={city ? "(default)" : ""} style={typeof like === "object" ? { fontFamily: "monospace", fontSize: 12 } : undefined} />}
      {dirty && <button className="btn small" style={{ marginTop: 4 }} disabled={a.pending} onClick={save}>Save</button>}
      {err && <p className="error">{err}</p>}
      <a.Msg />
    </div>
  );
}
