import assertNode from "node:assert/strict";
import { deliver, hmacHex, signatureHeader } from "../_shared/webhooks.ts";
import { sendBatch } from "../send-webhooks/index.ts";

const job = { id: "d1", url: "https://shop.example.com/qcs", secret: "whsec_abc", event_type: "delivery.status_changed", payload: { id: "evt_1", type: "delivery.status_changed" }, attempt: 2 };

Deno.test("signature = HMAC-SHA256(secret, t.body) — matches the documented recipe", async () => {
  // known answer: printf '1700000000.{"a":1}' | openssl dgst -sha256 -hmac whsec_abc
  const h = await signatureHeader("whsec_abc", '{"a":1}', 1700000000);
  assertNode.equal(h, "t=1700000000,v1=3b843bacfb18cc5554542fdcc84d815b399c52758e508a6fcecf0a2af4efea2b");   // same as openssl and PHP hash_hmac
  assertNode.match(h, /^t=1700000000,v1=[0-9a-f]{64}$/);
});

Deno.test("sends the raw JSON with signature, event and attempt headers; 2xx = delivered", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const a = await deliver(job, (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response("thanks", { status: 202 }); }) as typeof fetch, 1700000000);
  assertNode.deepEqual(a, { ok: true, status: 202, error: null, response: "thanks" });
  const h = seen!.init.headers as Record<string, string>;
  assertNode.equal(seen!.init.body, JSON.stringify(job.payload));
  assertNode.equal(seen!.init.redirect, "manual");
  assertNode.equal(h["QCS-Signature"], `t=1700000000,v1=${await hmacHex("whsec_abc", `1700000000.${JSON.stringify(job.payload)}`)}`);
  assertNode.equal(h["QCS-Event"], "delivery.status_changed");
  assertNode.equal(h["QCS-Delivery-Attempt"], "2");
});

Deno.test("errors, redirects and silence are failures (retried by the database)", async () => {
  const r500 = await deliver(job, (async () => new Response("oops", { status: 500 })) as typeof fetch);
  assertNode.deepEqual([r500.ok, r500.status, r500.error, r500.response], [false, 500, "HTTP 500", "oops"]);
  const r301 = await deliver(job, (async () => new Response(null, { status: 301, headers: { location: "http://10.0.0.1/" } })) as typeof fetch);
  assertNode.match(r301.error!, /redirect \(not followed/);
  const down = await deliver(job, (async () => { throw new TypeError("connection refused"); }) as typeof fetch);
  assertNode.deepEqual([down.ok, down.status, down.error], [false, null, "connection refused"]);
  const slow = await deliver(job, ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))))) as typeof fetch, undefined, 20);
  assertNode.equal(slow.error, "no answer within 10 seconds");
});

Deno.test("batch reports every result back", async () => {
  const done: [string, boolean][] = [];
  const r = await sendBatch({
    claim: async () => [job, { ...job, id: "d2", url: "https://down.example.com" }],
    finish: async (id, a) => { done.push([id, a.ok]); },
    fetch: (async (url: string) => (url.includes("down") ? new Response("", { status: 503 }) : new Response("ok"))) as typeof fetch,
  });
  assertNode.deepEqual(r, { sent: 1, failed: 1 });
  assertNode.deepEqual(done.sort(), [["d1", true], ["d2", false]]);
});
