/**
 * Business webhooks: signing and one delivery attempt. Pure functions (fetch passed in) so they can be tested.
 * Signature: QCS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 */
export interface WebhookJob { id: string; url: string; secret: string; event_type: string; payload: unknown; attempt: number }
export interface Attempt { ok: boolean; status: number | null; error: string | null; response: string | null }

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signatureHeader(secret: string, rawBody: string, nowSeconds: number): Promise<string> {
  return `t=${nowSeconds},v1=${await hmacHex(secret, `${nowSeconds}.${rawBody}`)}`;
}

/** POST one event. 2xx = delivered. Redirects are NOT followed (a redirect could point at a private address). 10-second limit. */
export async function deliver(job: WebhookJob, fetchImpl: typeof fetch, nowSeconds = Math.floor(Date.now() / 1000), timeoutMs = 10_000): Promise<Attempt> {
  const body = JSON.stringify(job.payload);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(job.url, {
      method: "POST", redirect: "manual", signal: ctrl.signal, body,
      headers: {
        "Content-Type": "application/json", "User-Agent": "QCS-Webhooks/1.0 (+https://qcsghana.com)",
        "QCS-Signature": await signatureHeader(job.secret, body, nowSeconds),
        "QCS-Event": job.event_type, "QCS-Delivery-Id": job.id, "QCS-Delivery-Attempt": String(job.attempt),
      },
    });
    const text = (await res.text().catch(() => "")).slice(0, 500);
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null, response: text };
    const why = res.status >= 300 && res.status < 400 ? `HTTP ${res.status} redirect (not followed — use the final URL)` : `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: why, response: text };
  } catch (e) {
    const err = e as Error;
    return { ok: false, status: null, error: err.name === "AbortError" ? "no answer within 10 seconds" : err.message.slice(0, 200), response: null };
  } finally {
    clearTimeout(timer);
  }
}
