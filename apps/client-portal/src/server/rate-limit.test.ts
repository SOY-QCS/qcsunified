import { describe, expect, it } from "vitest";
import { clientIp, LIMITS, limited, type Hit } from "./rate-limit";

/** In-memory counter with the same meaning as the database's rate_hit. */
function memoryHit(): Hit & { buckets: Map<string, number> } {
  const buckets = new Map<string, number>();
  const hit: Hit = async (bucket, max) => { const n = (buckets.get(bucket) ?? 0) + 1; buckets.set(bucket, n); return n <= max; };
  return Object.assign(hit, { buckets });
}

describe("rate limits", () => {
  it("lets people through up to the limit, then answers 429 with Retry-After", async () => {
    const hit = memoryHit();
    for (let i = 0; i < LIMITS.track.max; i++) expect(await limited("track", "ip:1.2.3.4", hit)).toBeNull();
    const r = await limited("track", "ip:1.2.3.4", hit);
    expect(r?.status).toBe(429);
    expect(Number(r?.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(r?.headers.get("Access-Control-Allow-Origin")).toBe("*");      // the website can read the message
    expect((await r!.json()).error).toMatch(/wait a minute/);
  });

  it("counts each visitor and each route separately", async () => {
    const hit = memoryHit();
    for (let i = 0; i < LIMITS.payments.max; i++) await limited("payments", "user:a", hit);
    expect((await limited("payments", "user:a", hit))?.status).toBe(429);
    expect(await limited("payments", "user:b", hit)).toBeNull();
    expect(await limited("quotes", "user:a", hit)).toBeNull();
    expect([...hit.buckets.keys()]).toContain("payments:user:a");
  });

  it("hour-long limits say 'wait an hour'", async () => {
    const hit = memoryHit();
    for (let i = 0; i < LIMITS.confirmMove.max; i++) await limited("confirmMove", "link:t", hit);
    expect((await (await limited("confirmMove", "link:t", hit))!.json()).error).toMatch(/hour/);
  });

  it("reads the visitor IP from the proxy headers", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "41.66.1.2, 10.0.0.1" } }))).toBe("41.66.1.2");
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "41.66.1.3" } }))).toBe("41.66.1.3");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});
