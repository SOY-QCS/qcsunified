"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useRun } from "@/components/run";
import { CATEGORIES } from "@/lib/sla";
import { addCanned, deleteCanned, saveArticle } from "./actions";

type A = { id: string | null; slug: string; audience: "all" | "client" | "vendor" | "rider"; category: string; title: string; body: string; sort: number; published: boolean };

export function ArticleForm({ v }: { v: A }) {
  const [f, setF] = useState(v);
  const a = useRun();
  const router = useRouter();
  return (
    <div>
      <div className="row">
        <div><label>Title (the question)</label><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value, slug: v.id ? f.slug : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) })} /></div>
        <div><label>Web address</label><input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} /></div>
      </div>
      <div className="row">
        <div><label>For</label><select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value as A["audience"] })}><option value="all">Everyone</option><option value="client">Customers</option><option value="vendor">Vendors</option><option value="rider">Riders</option></select></div>
        <div><label>Section</label><input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Booking, Delivery, Money…" /></div>
        <div><label>Order</label><input type="number" value={f.sort} onChange={(e) => setF({ ...f, sort: Number(e.target.value) })} /></div>
      </div>
      <label>Text</label><textarea rows={10} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
      <label style={{ fontWeight: 400, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={f.published} onChange={(e) => setF({ ...f, published: e.target.checked })} />Published (visible to everyone)</label>
      <button className="btn" style={{ marginTop: 10 }} disabled={a.pending} onClick={() => a.run(() => saveArticle(f), () => router.push("/crm/help"))}>Save article</button>
      <a.Msg />
    </div>
  );
}

export function CannedForm() {
  const [f, setF] = useState({ title: "", body: "", category: "" });
  const a = useRun();
  return (
    <div>
      <div className="row">
        <div><label>Title</label><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div><label>For problem</label><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">Any</option>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      </div>
      <label>Reply text</label><textarea rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
      <button className="btn small" style={{ marginTop: 8 }} disabled={a.pending} onClick={() => a.run(() => addCanned({ ...f, category: f.category || null }), () => setF({ title: "", body: "", category: "" }))}>Add</button>
      <a.Msg />
    </div>
  );
}

export function DeleteCanned({ id }: { id: string }) {
  const a = useRun();
  return <><button className="btn small secondary" disabled={a.pending} onClick={() => { if (window.confirm("Delete this canned reply?")) a.run(() => deleteCanned(id)); }}>Delete</button><a.Msg /></>;
}
