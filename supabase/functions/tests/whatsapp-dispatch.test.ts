import assertNode from "node:assert/strict";
import { handle } from "../whatsapp-webhook/index.ts";
import { inboundMessages, textMessages, validSignature } from "../_shared/whatsapp.ts";
import { googleRouteMatrix, rankAll } from "../dispatch-rank/index.ts";

const eq = (a: unknown, b: unknown) => assertNode.deepEqual(a, b);
const SECRET = "meta-app-secret";
async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}
const msg = (id: string, text: string) => JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from: "233200000401", type: "text", text: { body: text } }] } }] }] });

function deps() {
  const replies: string[] = [];
  const seen = new Set<string>();
  return {
    replies,
    d: {
      verifyToken: "verify-me", appSecret: SECRET,
      handle: async (m: { id: string; body: string }) => { if (seen.has(m.id)) return null; seen.add(m.id); return `OK: ${m.body}`; },
      reply: async (_to: string, body: string) => { replies.push(body); },
    },
  };
}

Deno.test("Meta webhook check", async () => {
  const { d } = deps();
  eq((await handle(new Request("http://x/?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42"), d)).status, 200);
  eq(await (await handle(new Request("http://x/?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42"), d)).text(), "42");
  eq((await handle(new Request("http://x/?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42"), d)).status, 403);
});

Deno.test("signed message is handled and answered once", async () => {
  const { d, replies } = deps();
  const body = msg("wamid.1", "DELIVERED ACC-202611041301-ACC 4821");
  const req = async () => new Request("http://x/", { method: "POST", body, headers: { "x-hub-signature-256": await sign(body) } });
  eq((await handle(await req(), d)).status, 200);
  eq((await handle(await req(), d)).status, 200);      // Meta retries the same message
  eq(replies, ["OK: DELIVERED ACC-202611041301-ACC 4821"]);
});

Deno.test("forged or unsigned messages are refused", async () => {
  const { d, replies } = deps();
  const body = msg("wamid.2", "DELIVERED X 1");
  eq((await handle(new Request("http://x/", { method: "POST", body, headers: { "x-hub-signature-256": await sign(body, "someone-else") } }), d)).status, 401);
  eq((await handle(new Request("http://x/", { method: "POST", body }), d)).status, 401);
  eq((await handle(new Request("http://x/", { method: "POST", body: body + " ", headers: { "x-hub-signature-256": await sign(body) } }), d)).status, 401);  // body changed after signing
  eq(replies, []);
});

Deno.test("customer photos and names are read; receipts ignored", async () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: "233551234567", profile: { name: "Yaa Asantewaa" } }],
    statuses: [{ id: "x" }],
    messages: [
      { id: "a", from: "233551234567", type: "image", image: { id: "media-1", mime_type: "image/jpeg", caption: "box is wet" } },
      { id: "b", from: "233551234567", type: "text", text: { body: "hello" } },
      { id: "c", from: "233551234567", type: "reaction" },
    ] } }] }] };
  eq(inboundMessages(payload), [
    { id: "a", from: "233551234567", name: "Yaa Asantewaa", body: "box is wet", media: { kind: "image", id: "media-1", mime: "image/jpeg", filename: undefined } },
    { id: "b", from: "233551234567", name: "Yaa Asantewaa", body: "hello", media: null },
  ]);
  eq(textMessages(payload), [{ id: "b", from: "233551234567", body: "hello" }]);    // rider commands: text only
  eq(await validSignature("x", null, SECRET), false);
});

Deno.test("a photo is saved and passed with the message", async () => {
  const got: unknown[] = [];
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "p1", from: "233551234567", type: "image", image: { id: "m1", mime_type: "image/jpeg" } }] } }] }] });
  await handle(new Request("http://x/", { method: "POST", body, headers: { "x-hub-signature-256": await sign(body) } }), {
    verifyToken: "v", appSecret: SECRET, reply: async () => {},
    saveMedia: async (m) => `wa/${m.id}.jpg`,
    handle: async (m, path) => { got.push([m.media?.kind, path]); return null; },
  });
  eq(got, [["image", "wa/p1.jpg"]]);
});

Deno.test("riders ranked by road time, not straight line", async () => {
  const saved: Record<string, string[]> = {};
  const r = await rankAll({
    tripsToRank: async () => [{ trip_id: "t1", pickup_lat: 5.556, pickup_lng: -0.178 }],
    candidates: async () => ["near-but-river", "far-but-road"],          // straight-line order
    positions: async () => [{ rider_id: "near-but-river", lat: 5.56, lng: -0.17 }, { rider_id: "far-but-road", lat: 5.57, lng: -0.16 }],
    routeMatrix: async () => [900, 300],                                  // 15 min vs 5 min by road
    save: async (id, ranked) => { saved[id] = ranked; },
  });
  eq(r.ranked, 1);
  eq(saved.t1, ["far-but-road", "near-but-river"]);
});

Deno.test("Google down → straight-line order kept", async () => {
  const saved: Record<string, string[]> = {};
  await rankAll({
    tripsToRank: async () => [{ trip_id: "t1", pickup_lat: 5.5, pickup_lng: -0.1 }],
    candidates: async () => ["a", "b"], positions: async () => [{ rider_id: "a", lat: 1, lng: 1 }, { rider_id: "b", lat: 1, lng: 1 }],
    routeMatrix: async () => { throw new Error("quota"); }, save: async (id, r) => { saved[id] = r; },
  });
  eq(saved.t1, ["a", "b"]);
});

Deno.test("Routes API request: motorbike, traffic-aware, durations read", async () => {
  let sent: Record<string, unknown> = {};
  const fake = (async (_u: string, init: RequestInit) => { sent = JSON.parse(init.body as string);
    return new Response(JSON.stringify([{ originIndex: 1, duration: "300s", condition: "ROUTE_EXISTS" }, { originIndex: 0, condition: "ROUTE_NOT_FOUND" }])); }) as unknown as typeof fetch;
  eq(await googleRouteMatrix("k", [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], { lat: 3, lng: 3 }, fake), [null, 300]);
  eq(sent.travelMode, "TWO_WHEELER");
});
