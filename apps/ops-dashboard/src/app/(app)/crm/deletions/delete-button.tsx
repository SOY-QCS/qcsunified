"use client";
import { useState } from "react";
import { useRun } from "@/components/run";
import { deleteAccount, logRequest, removeLogin } from "./actions";

export function DeleteButton({ id, blocked }: { id: string; blocked: boolean }) {
  const a = useRun();
  const [note, setNote] = useState("");
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 240 }}>
      <input placeholder="Note (what you checked)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn small danger" disabled={a.pending || blocked || note.trim().length < 3}
        onClick={() => { if (window.confirm("Erase this person's details and remove their login? This cannot be undone.")) a.run(() => deleteAccount(id, note)); }}>
        Delete account
      </button>
      <a.Msg />
    </div>
  );
}

export function LogRequest() {
  const a = useRun();
  const [phone, setPhone] = useState(""), [how, setHow] = useState("");
  return (
    <div className="card" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
      <strong>Asked by WhatsApp, email or phone?</strong>
      <input placeholder="Their phone number" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ maxWidth: 180 }} />
      <input placeholder="How they asked (e.g. WhatsApp from their number)" value={how} onChange={(e) => setHow(e.target.value)} style={{ maxWidth: 320 }} />
      <button className="btn small secondary" disabled={a.pending || phone.trim().length < 9 || how.trim().length < 3} onClick={() => a.run(() => logRequest(phone, how))}>Log request</button>
      <a.Msg />
    </div>
  );
}

export function RemoveLoginButton({ id }: { id: string }) {
  const a = useRun();
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 240 }}>
      <button className="btn small danger" disabled={a.pending} onClick={() => a.run(() => removeLogin(id))}>Remove login</button>
      <a.Msg />
    </div>
  );
}
