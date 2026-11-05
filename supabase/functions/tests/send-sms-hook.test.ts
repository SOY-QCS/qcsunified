import assertNode from "node:assert/strict";
const assertEquals = (a: unknown, b: unknown) => assertNode.deepEqual(a, b);
const assert = (v: unknown) => assertNode.ok(v);
import { Webhook } from "npm:standardwebhooks@1.0.0";
import { handle } from "../send-sms-hook/index.ts";
import { normalizeGhanaPhone, buildHubtelRequest } from "../_shared/hubtel-sms.ts";

const secret = btoa("a-test-secret-that-is-32-bytes!!");
const hubtel = { clientId: "id", clientSecret: "sec", senderId: "QCS" };

function signed(body: unknown, key = secret) {
  const payload = JSON.stringify(body);
  const id = "msg_1", ts = new Date();
  const sig = new Webhook(key).sign(id, ts, payload);
  return new Request("http://x/send-sms-hook", {
    method: "POST", body: payload,
    headers: { "webhook-id": id, "webhook-timestamp": String(Math.floor(ts.getTime() / 1000)), "webhook-signature": sig },
  });
}

Deno.test("phone numbers are normalised to +233", () => {
  assertEquals(normalizeGhanaPhone("024 123 4567"), "+233241234567");
  assertEquals(normalizeGhanaPhone("233241234567"), "+233241234567");
  assertEquals(normalizeGhanaPhone("+233 54 123 4567"), "+233541234567");
  assertEquals(normalizeGhanaPhone("12345"), null);
});

Deno.test("Hubtel request uses Basic Auth and From/To/Content", () => {
  const { url, init } = buildHubtelRequest(hubtel, "+233241234567", "hi");
  assertEquals(url, "https://smsc.hubtel.com/v1/messages/send");
  assertEquals((init.headers as Record<string, string>).Authorization, `Basic ${btoa("id:sec")}`);
  assertEquals(JSON.parse(init.body as string), { From: "QCS", To: "+233241234567", Content: "hi" });
});

Deno.test("valid hook call sends the code through Hubtel", async () => {
  let sent: { url: string; body: Record<string, string> } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent = { url, body: JSON.parse(init.body as string) };
    return new Response(JSON.stringify({ status: 0, messageId: "abc", statusDescription: "request submitted successfully" }));
  }) as unknown as typeof fetch;
  const res = await handle(signed({ user: { phone: "233241234567" }, sms: { otp: "561166" } }), { hookSecrets: [secret], hubtel, fetchImpl: fakeFetch });
  assertEquals(res.status, 200);
  assert(sent);
  assertEquals(sent!.body.To, "+233241234567");
  assert(sent!.body.Content.includes("561166"));
});

Deno.test("unsigned or forged calls are refused and nothing is sent", async () => {
  let called = false;
  const fakeFetch = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  const forged = signed({ user: { phone: "233241234567" }, sms: { otp: "1" } }, btoa("some-other-secret-32-bytes-long!"));
  const res = await handle(forged, { hookSecrets: [secret], hubtel, fetchImpl: fakeFetch });
  assertEquals(res.status, 401);
  assertEquals(called, false);
});

Deno.test("Hubtel failure returns a friendly error to Supabase", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ status: 4, statusDescription: "Insufficient balance" }), { status: 400 })) as unknown as typeof fetch;
  const res = await handle(signed({ user: { phone: "233241234567" }, sms: { otp: "1" } }), { hookSecrets: [secret], hubtel, fetchImpl: fakeFetch });
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.error.http_code, 502);
});

Deno.test("key rotation: either secret works", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ status: 0, messageId: "x" }))) as unknown as typeof fetch;
  const res = await handle(signed({ user: { phone: "0241234567" }, sms: { otp: "1" } }), { hookSecrets: [btoa("old-secret-old-secret-old-secret"), secret], hubtel, fetchImpl: fakeFetch });
  assertEquals(res.status, 200);
});

Deno.test("too many codes for one phone: refused with 429 and nothing is sent", async () => {
  let calls = 0;
  const fakeFetch = (async () => { calls++; return new Response(JSON.stringify({ status: 0 })); }) as unknown as typeof fetch;
  const counts = new Map<string, number>();
  const allow = async (phone: string) => { const n = (counts.get(phone) ?? 0) + 1; counts.set(phone, n); return n <= 5; };
  const results: number[] = [];
  for (let i = 0; i < 7; i++) {
    results.push((await handle(signed({ user: { phone: "233241234567" }, sms: { otp: "1" } }), { hookSecrets: [secret], hubtel, fetchImpl: fakeFetch, allow })).status);
  }
  assertEquals(results, [200, 200, 200, 200, 200, 429, 429]);
  assertEquals(calls, 5);
  // another phone is not affected
  assertEquals((await handle(signed({ user: { phone: "233200000000" }, sms: { otp: "1" } }), { hookSecrets: [secret], hubtel, fetchImpl: fakeFetch, allow })).status, 200);
});
