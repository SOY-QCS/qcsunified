"use client";
import { useState } from "react";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";

/** Add a note to a vendor / customer / lead timeline (notes can't be edited later). */
export function NoteBox({ subject, id }: { subject: "vendor" | "customer" | "lead"; id: string }) {
  const [text, setText] = useState("");
  const a = useRun();
  return (
    <div>
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note: what was discussed, what they want…" />
      <button className="btn small" style={{ marginTop: 6 }} disabled={a.pending || text.trim().length < 2}
        onClick={() => a.run(() => rpcAction("add_crm_note", { p_subject: subject, p_id: id, p_body: text }, "Note added"), () => setText(""))}>Add note</button>
      <a.Msg />
    </div>
  );
}

/** Tags and account manager. */
export function CrmProfile({ subject, id, tags, manager, managers, canEdit, hideManager }: {
  subject: "vendor" | "customer"; id: string; tags: string[]; manager: string | null; managers: { id: string; name: string }[]; canEdit: boolean;
  /** vendors: the account manager is set in Account controls */ hideManager?: boolean;
}) {
  const [t, setT] = useState(tags.join(", "));
  const [m, setM] = useState(manager ?? "");
  const a = useRun();
  return (
    <div className="row" style={{ alignItems: "end" }}>
      <div><label>Tags (comma separated)</label><input disabled={!canEdit} value={t} onChange={(e) => setT(e.target.value)} placeholder="vip, osu, fashion" /></div>
      {!hideManager && <div><label>Account manager</label><select disabled={!canEdit} value={m} onChange={(e) => setM(e.target.value)}>
        <option value="">None</option>{managers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>}
      {canEdit && <div style={{ flex: "0 0 auto" }}><button className="btn small" disabled={a.pending}
        onClick={() => a.run(() => rpcAction("set_crm_profile", { p_subject: subject, p_id: id, p_tags: t.split(",").map((x) => x.trim()).filter(Boolean), p_manager: m || null }, "Saved"))}>Save</button></div>}
      <a.Msg />
    </div>
  );
}
