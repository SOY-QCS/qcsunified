"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addWebhook, createKey, deleteWebhook, pingWebhook, resendDelivery, revokeKey, rotateSecret, saveShopifySettings, setWebhookActive, type R } from "./actions";

function useAct() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<R | null>(null);
  const router = useRouter();
  return {
    pending, msg,
    run: (fn: () => Promise<R>, then?: (r: R) => void) => start(async () => { const r = await fn(); setMsg(r); if (r.ok) { router.refresh(); then?.(r); } }),
    Msg: () => (msg ? <p className={msg.ok ? "notice" : "error"}>{msg.message}</p> : null),
  };
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button className="btn small secondary" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>{done ? "Copied ✓" : "Copy"}</button>;
}

export function NewKey({ vendorId, canLive }: { vendorId: string; canLive: boolean }) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"test" | "live">("test");
  const [shown, setShown] = useState<{ key: string; mode: string } | null>(null);
  const a = useAct();
  if (shown) return (
    <div className="card" style={{ borderColor: "var(--qcs-orange)" }}>
      <strong>Your new {shown.mode} key — copy it now. We won&apos;t show it again.</strong>
      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0", flexWrap: "wrap" }}>
        <code style={{ background: "#f4efe9", padding: "8px 10px", borderRadius: 6, wordBreak: "break-all", flex: 1 }}>{shown.key}</code><Copy text={shown.key} />
      </div>
      <p className="muted">Paste it into your plugin settings or your server&apos;s configuration. Never put it in a website&apos;s public code or an app.</p>
      <button className="btn small" onClick={() => setShown(null)}>I&apos;ve saved it</button>
    </div>
  );
  return (
    <div className="card">
      <strong>Create a key</strong>
      <div className="row" style={{ alignItems: "end" }}>
        <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. WooCommerce shop" /></div>
        <div><label>Mode</label><select value={mode} onChange={(e) => setMode(e.target.value as "test" | "live")}>
          <option value="test">Test — practice deliveries, nothing real</option><option value="live" disabled={!canLive}>Live — real deliveries{canLive ? "" : " (after ID check)"}</option></select></div>
        <div style={{ flex: "0 0 auto" }}><button className="btn" disabled={a.pending || name.trim().length < 2}
          onClick={() => a.run(() => createKey(vendorId, name, mode), (r) => { setShown(r.data as { key: string; mode: string }); setName(""); })}>Create key</button></div>
      </div>
      <a.Msg />
    </div>
  );
}

export function RevokeKey({ id, name }: { id: string; name: string }) {
  const a = useAct();
  return <><button className="btn small secondary" disabled={a.pending} onClick={() => { if (window.confirm(`Revoke "${name}"? Anything using it stops working immediately.`)) a.run(() => revokeKey(id)); }}>Revoke</button><a.Msg /></>;
}

export function AddWebhook({ vendorId }: { vendorId: string }) {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"live" | "test">("test");
  const [events, setEvents] = useState("*");
  const a = useAct();
  return (
    <div className="card">
      <strong>Add an endpoint</strong>
      <div className="row" style={{ alignItems: "end" }}>
        <div style={{ flex: "3 1 280px" }}><label>URL (https)</label><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://myshop.com/qcs-webhook" /></div>
        <div><label>Mode</label><select value={mode} onChange={(e) => setMode(e.target.value as "live" | "test")}><option value="test">Test deliveries</option><option value="live">Live deliveries</option></select></div>
        <div><label>Events</label><select value={events} onChange={(e) => setEvents(e.target.value)}>
          <option value="*">All events</option><option value="delivery.status_changed">Status changes only</option><option value="delivery.created">New deliveries only</option></select></div>
        <div style={{ flex: "0 0 auto" }}><button className="btn" disabled={a.pending || !url.trim()} onClick={() => a.run(() => addWebhook(vendorId, { url, mode, events: [events as "*"] }), () => setUrl(""))}>Add</button></div>
      </div>
      <a.Msg />
    </div>
  );
}

export function WebhookTools({ id, secret, active }: { id: string; secret: string; active: boolean }) {
  const [show, setShow] = useState(false);
  const a = useAct();
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span className="muted">Signing secret:</span>
        <code style={{ wordBreak: "break-all" }}>{show ? secret : `${secret.slice(0, 10)}••••••••`}</code>
        <button className="btn small secondary" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
        {show && <Copy text={secret} />}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        <button className="btn small" disabled={a.pending || !active} onClick={() => a.run(() => pingWebhook(id))}>Send test event</button>
        <button className="btn small secondary" disabled={a.pending} onClick={() => a.run(() => setWebhookActive(id, !active))}>{active ? "Turn off" : "Turn on"}</button>
        <button className="btn small secondary" disabled={a.pending} onClick={() => { if (window.confirm("Make a new signing secret? Your system must use the new one from now on.")) a.run(() => rotateSecret(id), () => setShow(true)); }}>New secret</button>
        <button className="btn small secondary" disabled={a.pending} onClick={() => { if (window.confirm("Delete this webhook?")) a.run(() => deleteWebhook(id)); }}>Delete</button>
      </div>
      <a.Msg />
    </div>
  );
}

export function Resend({ id }: { id: string }) {
  const a = useAct();
  return <><button className="btn small secondary" disabled={a.pending} onClick={() => a.run(() => resendDelivery(id))}>Resend</button><a.Msg /></>;
}

export function ShopifyConnect() {
  const [shop, setShop] = useState("");
  return (
    <form action="/api/integrations/shopify/install" method="get" className="row" style={{ alignItems: "end" }}>
      <div><label>Your Shopify store</label><input name="shop" value={shop} onChange={(e) => setShop(e.target.value)} placeholder="my-shop.myshopify.com" required /></div>
      <div style={{ flex: "0 0 auto" }}><button className="btn" disabled={!shop.trim()}>Connect Shopify</button></div>
    </form>
  );
}

export function ShopifySettings({ shop, v }: { shop: string; v: { service: "ecommerce" | "express"; auto_create: boolean } }) {
  const [f, setF] = useState(v);
  const a = useAct();
  return (
    <div className="row" style={{ alignItems: "end" }}>
      <div><label>Service at checkout</label><select value={f.service} onChange={(e) => setF({ ...f, service: e.target.value as "ecommerce" | "express" })}>
        <option value="ecommerce">Same-day / inter-city (by zone)</option><option value="express">Express (rider now)</option></select></div>
      <label style={{ fontWeight: 400, display: "flex", gap: 6, alignItems: "center", flex: "1 1 260px" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={f.auto_create} onChange={(e) => setF({ ...f, auto_create: e.target.checked })} />Book a QCS delivery automatically when an order is paid</label>
      <div style={{ flex: "0 0 auto" }}><button className="btn small" disabled={a.pending} onClick={() => a.run(() => saveShopifySettings(shop, f))}>Save</button></div>
      <a.Msg />
    </div>
  );
}
