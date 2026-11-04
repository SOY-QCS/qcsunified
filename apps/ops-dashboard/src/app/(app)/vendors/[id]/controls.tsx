"use client";
import { useState } from "react";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";

type V = { booking_blocked: boolean; cod_payout_on_hold: boolean; cod_payout_schedule: string; pod_require_photo: boolean; pod_require_pickup_code: boolean;
  cs_service_enabled: boolean; fulfilment_enabled: boolean; account_manager_id: string };
const MONEY = ["booking_blocked", "cod_payout_on_hold", "cod_payout_schedule"] as const;

/** Account controls. Money controls are Finance's (the database refuses anyone else); every change needs a reason. */
export function VendorControls({ id, v, reason, managers, canMoney, canOther }: { id: string; v: V; reason: string | null; managers: { id: string; name: string }[]; canMoney: boolean; canOther: boolean }) {
  const [f, setF] = useState(v);
  const [why, setWhy] = useState("");
  const a = useRun();
  const changed = (Object.keys(f) as (keyof V)[]).filter((k) => f[k] !== v[k]);
  const box = (k: keyof V, label: string, money = false) => (
    <label key={k} style={{ fontWeight: 400, display: "flex", gap: 8, alignItems: "center" }}>
      <input type="checkbox" style={{ width: "auto" }} disabled={money ? !canMoney : !canOther} checked={f[k] as boolean} onChange={(e) => setF({ ...f, [k]: e.target.checked })} />{label}
    </label>
  );
  return (
    <div className="card">
      <strong>Account controls</strong>
      <div className="row">
        <div>
          <p className="muted" style={{ marginBottom: 4 }}>Money (Finance)</p>
          {box("booking_blocked", "Block new bookings", true)}
          {v.booking_blocked && reason && <p className="muted">Blocked because: {reason}</p>}
          {box("cod_payout_on_hold", "Hold COD payouts (fees overdue)", true)}
          <label>COD payout schedule</label>
          <select disabled={!canMoney} value={f.cod_payout_schedule} onChange={(e) => setF({ ...f, cod_payout_schedule: e.target.value })}><option value="daily">Daily</option><option value="weekly">Weekly</option></select>
        </div>
        <div>
          <p className="muted" style={{ marginBottom: 4 }}>Service</p>
          {box("pod_require_photo", "Delivery photo required")}
          {box("pod_require_pickup_code", "Pickup code required")}
          {box("cs_service_enabled", "QCS customer service for their customers")}
          {box("fulfilment_enabled", "Fulfilment (storage at hub)")}
          <label>Account manager</label>
          <select disabled={!canOther} value={f.account_manager_id} onChange={(e) => setF({ ...f, account_manager_id: e.target.value })}><option value="">None</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        </div>
      </div>
      {changed.length > 0 && <div className="row" style={{ alignItems: "end", marginTop: 8 }}>
        <div><label>Reason (goes in the audit log)</label><input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. Invoice of September unpaid" /></div>
        <div style={{ flex: "0 0 auto" }}><button className="btn" disabled={a.pending || why.trim().length < 5}
          onClick={() => a.run(() => rpcAction("set_vendor_controls", { p_vendor: id, p: Object.fromEntries(changed.map((k) => [k, f[k]])), p_reason: why }, "Saved"), () => setWhy(""))}>Save {changed.length} change(s)</button></div>
      </div>}
      {changed.some((k) => (MONEY as readonly string[]).includes(k)) && !canMoney && <p className="error">Only Finance can change money controls.</p>}
      <a.Msg />
    </div>
  );
}
