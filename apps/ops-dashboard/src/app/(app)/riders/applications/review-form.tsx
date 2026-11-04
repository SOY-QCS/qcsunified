"use client";
import { useActionState, useState } from "react";
import { reviewRider, type ReviewState } from "./actions";

export function ReviewForm({ riderId, requestedType }: { riderId: string; requestedType: string }) {
  const [state, action, pending] = useActionState<ReviewState, FormData>(reviewRider, { ok: false, message: "" });
  const [type, setType] = useState(requestedType);
  if (state.ok) return <p className="notice">{state.message}</p>;
  return (
    <form action={action}>
      <input type="hidden" name="rider_id" value={riderId} />
      <div className="row">
        <div>
          <label>Rider type</label>
          <select name="rider_type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="commission">Independent (commission)</option>
            <option value="fleet">QCS fleet</option>
          </select>
        </div>
        {type === "commission" && <div><label>Commission %</label><input name="commission_pct" type="number" min={0} max={100} defaultValue={20} /></div>}
      </div>
      <label>Note to rider (required when rejecting)</label>
      <input name="note" placeholder="e.g. Licence photo is blurry — please retake it" />
      {state.message && <p className="error">{state.message}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" name="decision" value="approve" disabled={pending}>Approve</button>
        <button className="btn danger" name="decision" value="reject" disabled={pending}>Reject</button>
      </div>
    </form>
  );
}
