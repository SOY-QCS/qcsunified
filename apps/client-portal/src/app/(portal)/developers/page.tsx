import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";
import { currentVendor } from "../vendor";
import { AddWebhook, NewKey, Resend, RevokeKey, ShopifyConnect, ShopifySettings, WebhookTools } from "./tools";

const when = (d: string | null) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const TABS = [["keys", "API keys"], ["webhooks", "Webhooks"], ["logs", "API logs"], ["integrations", "WooCommerce & Shopify"]] as const;

/** Developers: API keys, webhooks with their delivery log, the API request log, and the shop integrations. */
export default async function Developers({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : "keys";
  const { vendor } = await currentVendor();
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  const [{ data: v }, { data: staff }] = await Promise.all([
    sb.from("vendors").select("owner_id, kyc_status").eq("id", vendor.id).single(),
    sb.from("vendor_staff").select("permissions").eq("vendor_id", vendor.id).eq("user_id", user!.id).eq("is_active", true).maybeSingle(),
  ]);
  const allowed = v?.owner_id === user!.id || !!staff?.permissions?.includes("api");
  const shopifyNote = sp.shopify === "connected" ? { ok: true, text: "Shopify connected. QCS now shows at your checkout." }
    : sp.shopify_error ? { ok: false, text: `Shopify: ${sp.shopify_error}` } : null;

  return (
    <>
      <h1>Developers</h1>
      <p>Connect your website or online shop to QCS: prices at checkout, deliveries booked automatically, status updates sent back. <Link href="/docs/api">API documentation →</Link></p>
      {shopifyNote && <p className={shopifyNote.ok ? "notice" : "error"}>{shopifyNote.text}</p>}
      {!allowed ? <div className="card">Ask the account owner to give you the &quot;API&quot; permission to manage keys and webhooks.</div> : <>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
          {TABS.map(([k, l]) => <Link key={k} href={`/developers?tab=${k}`} className={`btn small ${tab === k ? "" : "secondary"}`}>{l}</Link>)}
        </div>
        {tab === "keys" && <Keys vendorId={vendor.id} canLive={v?.kyc_status === "approved"} pickup={vendor.pickup?.formatted_address ?? null} />}
        {tab === "webhooks" && <Webhooks vendorId={vendor.id} />}
        {tab === "logs" && <Logs errorsOnly={sp.errors === "1"} />}
        {tab === "integrations" && <Integrations />}
      </>}
    </>
  );
}

async function Keys({ vendorId, canLive, pickup }: { vendorId: string; canLive: boolean; pickup: string | null }) {
  const { data: keys } = await (await supabaseServer()).from("api_keys").select("id, name, key_prefix, mode, created_at, last_used_at, revoked_at").order("created_at", { ascending: false });
  return (
    <>
      <NewKey vendorId={vendorId} canLive={canLive} />
      {!canLive && <p className="muted">Live keys become available once QCS has verified your business ID. Test keys work now: they create practice deliveries that nobody picks up and that cost nothing.</p>}
      <table>
        <thead><tr><th>Name</th><th>Key</th><th>Mode</th><th>Created</th><th>Last used</th><th></th></tr></thead>
        <tbody>
          {(keys ?? []).map((k) => (
            <tr key={k.id} style={{ opacity: k.revoked_at ? 0.5 : 1 }}>
              <td>{k.name}</td><td><code>{k.key_prefix}…</code></td>
              <td><span className="tag">{k.mode}</span></td><td>{when(k.created_at)}</td><td>{when(k.last_used_at)}</td>
              <td>{k.revoked_at ? `revoked ${when(k.revoked_at)}` : <RevokeKey id={k.id} name={k.name} />}</td>
            </tr>
          ))}
          {!keys?.length && <tr><td colSpan={6} className="muted">No keys yet.</td></tr>}
        </tbody>
      </table>
      <div className="card">
        <strong>Default pickup address</strong>
        <p style={{ margin: "6px 0 0" }}>{pickup ?? "Not set"} <span className="muted">— used when an API call or plugin doesn&apos;t send a pickup.</span></p>
      </div>
    </>
  );
}

async function Webhooks({ vendorId }: { vendorId: string }) {
  const sb = await supabaseServer();
  const [{ data: hooks }, { data: log }] = await Promise.all([
    sb.from("webhooks").select("id, url, mode, events, is_active, secret, failure_streak, disabled_reason, last_success_at, created_at").eq("vendor_id", vendorId).order("created_at"),
    sb.from("webhook_deliveries").select("id, webhook_id, event_type, status, attempts, next_attempt_at, last_status_code, last_error, created_at, sent_at, payload")
      .eq("vendor_id", vendorId).order("created_at", { ascending: false }).limit(50),
  ]);
  const urlOf = (id: string) => hooks?.find((h) => h.id === id)?.url ?? "";
  return (
    <>
      <p className="muted">We POST every delivery status change to these addresses, signed with the endpoint&apos;s secret (see <Link href="/docs/api#webhooks">how to check the signature</Link>).
        If your server doesn&apos;t answer 2xx we retry for about 2 days.</p>
      {(hooks ?? []).map((h) => (
        <div key={h.id} className="card">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <strong style={{ wordBreak: "break-all" }}>{h.url}</strong><span className="tag">{h.mode}</span>
            <span className="tag">{h.events.includes("*") ? "all events" : h.events.join(", ")}</span>
            {h.is_active ? <span className="tag" style={{ background: "#e3f4ea", color: "var(--success)" }}>on</span> : <span className="tag" style={{ background: "#fde8e6", color: "var(--danger)" }}>off</span>}
          </div>
          {h.disabled_reason && <p className="error">Turned off: {h.disabled_reason}</p>}
          <p className="muted" style={{ margin: "6px 0" }}>Last delivered {when(h.last_success_at)}{h.failure_streak ? ` · ${h.failure_streak} failed in a row` : ""}</p>
          <WebhookTools id={h.id} secret={h.secret} active={h.is_active} />
        </div>
      ))}
      {(hooks?.length ?? 0) < 5 && <AddWebhook vendorId={vendorId} />}
      <h2>Recent messages</h2>
      <table>
        <thead><tr><th>When</th><th>Event</th><th>Delivery</th><th>Endpoint</th><th>Result</th><th></th></tr></thead>
        <tbody>
          {(log ?? []).map((d) => {
            const data = (d.payload as { data?: { tracking_number?: string; status?: string } }).data;
            return (
              <tr key={d.id}>
                <td>{when(d.created_at)}</td><td>{d.event_type}</td>
                <td>{data?.tracking_number ?? "—"}{data?.status ? <div className="muted">{data.status}</div> : null}</td>
                <td style={{ maxWidth: 220, wordBreak: "break-all" }} className="muted">{urlOf(d.webhook_id)}</td>
                <td>{d.status === "sent" ? <span style={{ color: "var(--success)" }}>✓ {d.last_status_code}</span>
                  : d.status === "failed" ? <span style={{ color: "var(--danger)" }}>failed: {d.last_error}</span>
                  : <>{d.attempts ? `retrying (${d.attempts} tries, last: ${d.last_error ?? d.last_status_code}) — next ${when(d.next_attempt_at)}` : "queued"}</>}</td>
                <td>{(d.status === "failed" || d.status === "sent") && <Resend id={d.id} />}</td>
              </tr>
            );
          })}
          {!log?.length && <tr><td colSpan={6} className="muted">Nothing sent yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

async function Logs({ errorsOnly }: { errorsOnly: boolean }) {
  let q = (await supabaseServer()).from("api_requests").select("id, mode, method, path, status, duration_ms, error, reference, created_at, api_keys(name)").order("created_at", { ascending: false }).limit(100);
  if (errorsOnly) q = q.gte("status", 400);
  const { data } = await q;
  return (
    <>
      <p><Link className={`btn small ${errorsOnly ? "secondary" : ""}`} href="/developers?tab=logs">All</Link>{" "}
        <Link className={`btn small ${errorsOnly ? "" : "secondary"}`} href="/developers?tab=logs&errors=1">Errors only</Link>
        <span className="muted"> Last 100 calls (kept 30 days). The number in the first column is the QCS-Request-Id header.</span></p>
      <table>
        <thead><tr><th>#</th><th>When</th><th>Key</th><th>Call</th><th>Result</th><th>Time</th><th>Delivery</th></tr></thead>
        <tbody>
          {(data ?? []).map((r) => (
            <tr key={r.id}>
              <td className="muted">{r.id}</td><td>{when(r.created_at)}</td>
              <td>{(Array.isArray(r.api_keys) ? r.api_keys[0] : r.api_keys)?.name ?? "—"} <span className="tag">{r.mode}</span></td>
              <td><code>{r.method} {r.path}</code></td>
              <td style={{ color: (r.status ?? 500) >= 400 ? "var(--danger)" : "var(--success)" }}>{r.status ?? "…"}{r.error ? <div className="muted">{r.error}</div> : null}</td>
              <td>{r.duration_ms != null ? `${r.duration_ms} ms` : ""}</td><td>{r.reference}</td>
            </tr>
          ))}
          {!data?.length && <tr><td colSpan={7} className="muted">No API calls yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

async function Integrations() {
  const { data: shops } = await (await supabaseServer()).from("shopify_shops").select("shop, service, auto_create, installed_at, uninstalled_at, last_error").order("installed_at");
  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>WooCommerce (WordPress)</h2>
        <ol>
          <li><a className="btn small" href="/downloads/qcs-ghana-shipping.zip">Download the QCS plugin (.zip)</a></li>
          <li>In WordPress: Plugins → Add New → Upload Plugin → choose the file → Activate.</li>
          <li>WooCommerce → Settings → Shipping → <strong>QCS Ghana</strong>: paste an API key (start with a test key), press &quot;Test connection&quot;.</li>
          <li>Add &quot;QCS Ghana&quot; to your Ghana shipping zone. Customers now see QCS prices at checkout.</li>
          <li>When an order is paid (status Processing), the plugin books the delivery and adds the tracking number to the order. Cash on delivery orders send the order total as COD.</li>
        </ol>
        <p className="muted">Needs WordPress 6+, WooCommerce 8+, PHP 7.4+. Status updates come back to your orders automatically.</p>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Shopify</h2>
        <p>Connect once: QCS appears as a shipping option with live prices, and paid orders are booked automatically (the tracking number is added to the order).</p>
        <ShopifyConnect />
        <p className="muted">Live prices at checkout need Shopify&apos;s &quot;carrier-calculated shipping&quot; (included in the Advanced plan, or an add-on). Without it, automatic booking still works with a flat shipping rate you set in Shopify.</p>
        {(shops ?? []).map((s) => (
          <div key={s.shop} className="card" style={{ marginTop: 12 }}>
            <strong>{s.shop}</strong> <span className="tag">{s.uninstalled_at ? "disconnected" : "connected"}</span>
            <span className="muted"> since {when(s.installed_at)}</span>
            {s.last_error && <p className="error">Last problem: {s.last_error}</p>}
            {!s.uninstalled_at && <ShopifySettings shop={s.shop} v={{ service: s.service as "ecommerce" | "express", auto_create: s.auto_create }} />}
          </div>
        ))}
      </div>
    </>
  );
}
