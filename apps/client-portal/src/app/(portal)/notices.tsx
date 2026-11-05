import { anonClient } from "@/server/tracking";

type Status = { notice: string | null; pauses: { city_id: string; text: string }[] };

/** Paused cities and the general notice (set in Ops), shown at the top of every portal page. */
export async function Notices() {
  let status: Status | null = null;
  try {
    const { data } = await anonClient().rpc("app_status", { p_app: "client", p_version: "999", p_platform: "web" });
    status = (data as Status | null) ?? null;
  } catch { /* never break the page for a banner */ }
  const lines = [...(status?.pauses ?? []).map((p) => ({ key: p.city_id, text: p.text })), ...(status?.notice ? [{ key: "n", text: status.notice }] : [])];
  if (!lines.length) return null;
  return (
    <div style={{ background: "#fbeee4", color: "#b8500f", padding: "8px 16px" }}>
      {lines.map((l) => <div key={l.key} style={{ maxWidth: 1100, margin: "0 auto", fontWeight: 600 }}>{l.text}</div>)}
    </div>
  );
}
