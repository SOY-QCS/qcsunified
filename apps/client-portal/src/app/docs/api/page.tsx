import type { Metadata } from "next";
import { openApi } from "@/server/business/openapi";

export const metadata: Metadata = { title: "QCS Business API · Docs", description: "Book and track QCS Ghana deliveries from your own systems." };

type Op = { summary: string; description?: string; operationId: string; parameters?: { name: string; in: string; description?: string; required?: boolean }[];
  requestBody?: { content: Record<string, { example?: unknown }> }; responses: Record<string, { description: string }> };

const STATUSES = [
  ["CONFIRMED", "Booked"], ["SEARCHING_RIDER", "Finding a rider"], ["ASSIGNED", "Rider assigned"], ["RIDER_AT_PICKUP", "Rider at pickup"], ["PICKED_UP", "Picked up"],
  ["IN_TRANSIT", "On the way"], ["AT_HUB", "At QCS hub (inter-city)"], ["DEPARTED_HUB", "On the bus"], ["ARRIVED_DEST_HUB", "Arrived at destination hub"],
  ["READY_FOR_COLLECTION", "Ready for collection at the hub"], ["COLLECTED", "Collected (final)"], ["OUT_FOR_DELIVERY", "Out for delivery"], ["ARRIVED_AT_DROPOFF", "Rider has arrived"],
  ["DELIVERED", "Delivered (final)"], ["FAILED_ATTEMPT", "Attempt failed (reason given)"], ["RESCHEDULED", "Rescheduled"], ["RETURNING_TO_SENDER", "Returning to you"],
  ["RETURNED", "Returned (final)"], ["CANCELLED", "Cancelled (final)"], ["LOST", "Lost (claim opened)"], ["DAMAGED", "Damaged (claim opened)"],
];

const NODE = `import crypto from "node:crypto";

// Express: app.post("/qcs-webhook", express.raw({ type: "application/json" }), handler)
export function verifyQcs(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;      // older than 5 minutes
  const expected = crypto.createHmac("sha256", secret).update(\`\${parts.t}.\${rawBody}\`).digest("hex");
  return parts.v1?.length === 64 && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}`;
const PHP = `function qcs_verify($raw_body, $header, $secret) {
  parse_str(str_replace(',', '&', $header), $p);
  if (abs(time() - (int) ($p['t'] ?? 0)) > 300) return false;
  $expected = hash_hmac('sha256', $p['t'] . '.' . $raw_body, $secret);
  return hash_equals($expected, $p['v1'] ?? '');
}
// $raw = file_get_contents('php://input');
// qcs_verify($raw, $_SERVER['HTTP_QCS_SIGNATURE'], 'whsec_…')`;

/** Public developer documentation, rendered from the OpenAPI document (which is built from the server's own validation). */
export default function ApiDocs() {
  const base = process.env.PUBLIC_API_URL || "https://portal.qcsghana.com";
  const doc = openApi(base);
  const url = doc.servers[0]!.url;
  const curl = `curl ${url}/deliveries \\
  -H "Authorization: Bearer qcs_test_…" \\
  -H "Idempotency-Key: order-1042" \\
  -H "Content-Type: application/json" \\
  -d '{
    "reference": "1042",
    "dropoff": { "address": "12 Lagos Avenue, East Legon", "city": "Accra",
                 "contact_name": "Esi Mensah", "contact_phone": "0243334444" },
    "parcel": { "weight_g": 1500, "cod_amount": 25000 }
  }'`;
  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "24px 16px 60px" }}>
      <p className="brand" style={{ margin: 0 }}><span className="brand-mark">Q</span>QCS Business API</p>
      <h1 style={{ marginTop: 16 }}>Developer documentation</h1>
      <p>Book and track QCS deliveries from your website, shop or ERP. Using WooCommerce or Shopify? You don&apos;t need to code: install the plugin from
        the business portal → <a href="/developers">Developers</a>.</p>
      <p><a className="btn small secondary" href="/api/business/v1/openapi.json">OpenAPI file (import into Postman)</a></p>

      <h2>Quick start</h2>
      <ol>
        <li>In the business portal open <a href="/developers">Developers</a> and create a <strong>test key</strong> (<code>qcs_test_…</code>). Set a default pickup address.</li>
        <li>Create a practice delivery:</li>
      </ol>
      <pre className="code">{curl}</pre>
      <ol start={3}>
        <li>Move it along with <code>POST /deliveries/&#123;id&#125;/simulate</code> (<code>{`{"status":"DELIVERED"}`}</code>) and watch your webhook.</li>
        <li>When it all works, switch to a <strong>live key</strong> (available after QCS has verified your business ID).</li>
      </ol>
      <div className="card">
        <strong>Good to know</strong>
        <ul>
          <li>Base URL: <code>{url}</code> · JSON in, JSON out · money in <strong>pesewas</strong> (GHS 25.00 = 2500) · weights in grams.</li>
          <li>Send an <code>Idempotency-Key</code> when creating deliveries: if your request times out, retry with the same key and you&apos;ll never book twice.</li>
          <li>Addresses can be text — we find them on the map — or <code>lat</code>/<code>lng</code>. The recipient also gets a link to confirm their exact location.</li>
          <li>Limit: 120 requests per minute per key. Every answer has a <code>QCS-Request-Id</code> you can find in your API logs.</li>
          <li>Keep keys on your server. Anyone with a live key can book deliveries on your account. If a key leaks, revoke it in the portal.</li>
        </ul>
      </div>

      <h2>Endpoints</h2>
      {Object.entries(doc.paths).map(([path, methods]) => Object.entries(methods as Record<string, Op>).map(([m, op]) => {
        const ex = op.requestBody?.content["application/json"]?.example;
        return (
          <section key={op.operationId} className="card" id={op.operationId}>
            <h3 style={{ margin: "0 0 6px" }}><span className="tag">{m.toUpperCase()}</span> <code>{path}</code> — {op.summary}</h3>
            {op.description && <p>{op.description}</p>}
            {!!op.parameters?.length && <ul>{op.parameters.map((p) => <li key={p.name}><code>{p.name}</code> ({p.in}{p.required ? ", required" : ""}){p.description ? ` — ${p.description}` : ""}</li>)}</ul>}
            {ex !== undefined && <><p className="muted" style={{ margin: "8px 0 4px" }}>Example body</p><pre className="code">{JSON.stringify(ex, null, 2)}</pre></>}
            <p className="muted" style={{ margin: "8px 0 0" }}>{Object.entries(op.responses).map(([c, r]) => `${c} ${r.description}`).join(" · ")}</p>
          </section>
        );
      }))}

      <h2>Delivery request fields</h2>
      <FieldTable schema={doc.components.schemas.DeliveryRequest as Schema} />

      <h2>Statuses</h2>
      <table><tbody>{STATUSES.map(([s, t]) => <tr key={s}><td><code>{s}</code></td><td>{t}</td></tr>)}</tbody></table>
      <p className="muted">Cancel is possible until the rider has picked the parcel up. Failed and returned deliveries are charged 50% of the delivery fee.</p>

      <h2 id="webhooks">Webhooks</h2>
      <p>Add an https endpoint in the portal (one for test, one for live if you like). We POST every event as JSON:</p>
      <pre className="code">{JSON.stringify({ id: "evt_9b1d…", type: "delivery.status_changed", created_at: "2026-11-05T13:42:10Z", livemode: true,
        data: { tracking_number: "ACC-202611051301-ACC", reference: "1042", status: "DELIVERED", status_text: "Delivered", previous_status: "ARRIVED_AT_DROPOFF", reason: null, "…": "the full delivery" } }, null, 2)}</pre>
      <p>Each message has <code>QCS-Signature: t=&lt;unix time&gt;,v1=&lt;hex&gt;</code>, where <code>v1 = HMAC-SHA256(endpoint secret, &quot;&lt;t&gt;.&lt;raw body&gt;&quot;)</code>.
        Check it before trusting the message, reply 2xx within 10 seconds, and do the slow work afterwards. If we don&apos;t get a 2xx we retry after 1 min, 5 min, 15 min,
        1 h, 3 h, 6 h, 12 h and 24 h. An endpoint that keeps failing is turned off and you get an email. Events can arrive more than once or out of order: use
        <code>id</code> to ignore repeats and <code>changed_at</code> to keep the latest.</p>
      <p className="muted">Node.js</p><pre className="code">{NODE}</pre>
      <p className="muted">PHP</p><pre className="code">{PHP}</pre>
    </main>
  );
}

type Schema = { properties?: Record<string, Schema & { description?: string; type?: string | string[]; enum?: unknown[]; default?: unknown; anyOf?: Schema[] }>; required?: string[]; description?: string; type?: string | string[]; anyOf?: Schema[] };

function FieldTable({ schema, prefix = "" }: { schema: Schema; prefix?: string }) {
  const props = schema.properties ?? schema.anyOf?.find((s) => s.properties)?.properties ?? {};
  return (
    <table>
      <tbody>
        {Object.entries(props).flatMap(([k, v]) => {
          const inner = v.properties ? v : v.anyOf?.find((s) => s.properties);
          const type = v.enum ? v.enum.filter((x) => x !== null).join(" | ") : (Array.isArray(v.type) ? v.type.join("/") : v.type) ?? (inner ? "object" : "");
          const row = (
            <tr key={prefix + k}>
              <td><code>{prefix + k}</code>{schema.required?.includes(k) ? " *" : ""}</td>
              <td className="muted">{type}{v.default !== undefined && typeof v.default !== "object" ? ` (default ${String(v.default)})` : ""}</td>
              <td>{v.description ?? inner?.description ?? ""}</td>
            </tr>
          );
          return inner && prefix.split(".").length < 3 ? [row, <tr key={prefix + k + "_"}><td colSpan={3} style={{ paddingLeft: 18 }}><FieldTable schema={inner} prefix={`${prefix}${k}.`} /></td></tr>] : [row];
        })}
      </tbody>
    </table>
  );
}
