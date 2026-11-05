"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { problemsFor } from "@qcs/types";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { openTicket, replyTicket } from "./actions";

/** Photos go straight to the private "support" storage folder of the signed-in user, then the path is sent with the message. */
async function uploadPhoto(file: File | null): Promise<string | null> {
  if (!file) return null;
  if (file.size > 5_000_000) throw new Error("Photo is too big (max 5 MB)");
  const sb = supabaseBrowser();
  const { data: u } = await sb.auth.getUser();
  if (!u.user) throw new Error("Sign in again");
  const ext = file.type === "application/pdf" ? "pdf" : file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const path = `${u.user.id}/${Date.now()}.${ext}`;
  const { error } = await sb.storage.from("support").upload(path, file, { contentType: file.type });
  if (error) throw new Error(error.message);
  return path;
}

export function NewTicketForm({ tracking }: { tracking: string }) {
  const [tn, setTn] = useState(tracking);
  const choices = problemsFor("vendor", !!tn.trim());
  const [cat, setCat] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <label>Tracking number (leave empty for a general question)</label>
      <input value={tn} onChange={(e) => setTn(e.target.value)} placeholder="ACC-202611041301-KUM" />
      <label>What is it about?</label>
      <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Choose…</option>{choices.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
      <label>Tell us what happened</label>
      <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      <label>Photo (optional — helpful for damaged parcels)</label>
      <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <button className="btn" style={{ marginTop: 10 }} disabled={pending || !cat || text.trim().length < 5} onClick={() => start(async () => {
        try {
          const r = await openTicket(cat, text, tn.trim() || null, await uploadPhoto(file));
          setMsg({ ok: r.ok, text: r.message });
          if (r.ok && r.id) router.push(`/support/${r.id}`);
        } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
      })}>Send</button>
      {msg && <p className={msg.ok ? "notice" : "error"}>{msg.text}</p>}
    </div>
  );
}

export function ReplyForm({ ticket }: { ticket: string }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply" />
      <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <button className="btn" style={{ marginTop: 8 }} disabled={pending || (!text.trim() && !file)} onClick={() => start(async () => {
        try {
          const r = await replyTicket(ticket, text, await uploadPhoto(file));
          setMsg({ ok: r.ok, text: r.message });
          if (r.ok) { setText(""); setFile(null); router.refresh(); }
        } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
      })}>Send</button>
      {msg && <p className={msg.ok ? "notice" : "error"}>{msg.text}</p>}
    </div>
  );
}
