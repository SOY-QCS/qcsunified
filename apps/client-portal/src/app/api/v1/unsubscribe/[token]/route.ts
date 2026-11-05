import { anonClient, json, preflight } from "@/server/tracking";
import { clientIp, limited } from "@/server/rate-limit";

export const OPTIONS = preflight;

/** POST /api/v1/unsubscribe/<token> — the opt-out link in every offer. No login; delivery updates keep coming. */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const stop = await limited("unsubscribe", `ip:${clientIp(req)}`); if (stop) return stop;
  const { token } = await ctx.params;
  if (!/^[a-f0-9]{16,64}$/.test(token)) return json({ ok: false }, 404);
  const { data, error } = await anonClient().rpc("unsubscribe", { p_token: token });
  if (error) return json({ ok: false, error: "Please try again" }, 503);
  return json(data, (data as { ok: boolean }).ok ? 200 : 404);
}
