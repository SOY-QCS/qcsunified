import assertNode from "node:assert/strict";
import { sendBatch, type SendDeps } from "../send-notifications/index.ts";
import { readExpoTickets, waNumber, whatsappRequest, whatsappTemplateRequest, type Outgoing } from "../_shared/messages.ts";

const eq = (a: unknown, b: unknown) => assertNode.deepEqual(a, b);
const msg = (o: Partial<Outgoing>): Outgoing => ({ id: "1", channel: "sms", to: "+233241234567", key: "on_the_way", subject: "", body: "Hello", wa_template: null, wa_params: [], data: {}, ...o });

function deps(responses: Record<string, () => Response>, extra: Partial<SendDeps> = {}) {
  const finished: [string, boolean, string | undefined][] = [];
  const dropped: string[] = [];
  const calls: { url: string; body: unknown }[] = [];
  const d: SendDeps = {
    claim: async () => [], finish: async (id, ok, e) => { finished.push([id, ok, e]); }, dropToken: async (t) => { dropped.push(t); },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const k = Object.keys(responses).find((x) => url.includes(x));
      return k ? responses[k]!() : new Response("no", { status: 500 });
    }) as typeof fetch,
    sms: { clientId: "id", clientSecret: "s", senderId: "QCS" }, whatsapp: { token: "t", phoneNumberId: "99", version: "v21.0" }, email: null,
    ...extra,
  };
  return { d, finished, dropped, calls };
}

Deno.test("push: sent to every phone; uninstalled app tokens are forgotten", async () => {
  const t = deps({ "exp.host": () => Response.json({ data: [{ status: "ok" }, { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }] }) });
  t.d.claim = async () => [msg({ channel: "push", to: ["ExponentPushToken[a]", "ExponentPushToken[b]"], key: "job_offer", subject: "New job" })];
  eq(await sendBatch(t.d), { sent: 1, failed: 0 });
  eq(t.dropped, ["ExponentPushToken[b]"]);
  const body = t.calls[0]!.body as { to: string; ttl?: number; channelId: string }[];
  eq(body.map((b) => b.to), ["ExponentPushToken[a]", "ExponentPushToken[b]"]);
  eq([body[0]!.ttl, body[0]!.channelId], [20, "jobs"]);
});

Deno.test("SMS through Hubtel; failures are reported for retry", async () => {
  const t = deps({ "hubtel": () => new Response("down", { status: 503 }) });
  t.d.claim = async () => [msg({})];
  eq(await sendBatch(t.d), { sent: 0, failed: 1 });
  eq(t.finished[0]![1], false);
});

Deno.test("missing keys: reported, not crashed", async () => {
  const t = deps({}, { email: null });
  t.d.claim = async () => [msg({ channel: "email", to: "a@b.com" })];
  eq(await sendBatch(t.d), { sent: 0, failed: 1 });
  eq(t.finished[0]![2], "Resend key not set");
});

Deno.test("WhatsApp uses the approved template with its parameters in order", async () => {
  const r = whatsappTemplateRequest({ token: "t", phoneNumberId: "99", version: "v21.0" },
    msg({ channel: "whatsapp", to: "024 123 4567", wa_template: "qcs_on_the_way", wa_params: ["Kente Hub", "Kofi", ""] }));
  const b = JSON.parse(String(r.init.body));
  eq(b.to, "233241234567");
  eq(b.template.name, "qcs_on_the_way");
  eq(b.template.components[0].parameters.map((p: { text: string }) => p.text), ["Kente Hub", "Kofi", "-"]);
  assertNode.throws(() => whatsappTemplateRequest({ token: "t", phoneNumberId: "9", version: "v" }, msg({ channel: "whatsapp", wa_template: null })));
});

Deno.test("helpers", () => {
  eq([waNumber("+233 24 123 4567"), waNumber("0241234567"), waNumber("12")], ["233241234567", "233241234567", null]);
  eq(readExpoTickets(["x"], { data: [{ status: "error", message: "bad" }] }), { ok: false, dead: [], error: "bad" });
});

Deno.test("support reply inside the 24-hour window goes as plain WhatsApp text", () => {
  const cfg = { token: "t", phoneNumberId: "99", version: "v21.0" };
  const free = JSON.parse(String(whatsappRequest(cfg, msg({ channel: "whatsapp", to: "+233551234567", body: "QCS Support (#12): checking now", wa_template: null, data: { wa_text: true } })).init.body));
  assertNode.deepEqual([free.type, free.to, free.text.body], ["text", "233551234567", "QCS Support (#12): checking now"]);
  const late = JSON.parse(String(whatsappRequest(cfg, msg({ channel: "whatsapp", to: "+233551234567", wa_template: "qcs_support_reply", wa_params: ["12", "x"], data: { wa_text: false } })).init.body));
  assertNode.equal(late.type, "template");
  assertNode.throws(() => whatsappRequest(cfg, msg({ channel: "whatsapp", wa_template: null, data: {} })));   // never free text without the flag
});
