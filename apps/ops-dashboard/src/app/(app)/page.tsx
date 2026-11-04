import Link from "next/link";
import { getStaff } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { has, myCities } from "@/lib/ops";

/** Today at a glance (only the cities this person can see), with links into the work. */
export default async function Overview() {
  const staff = (await getStaff())!;
  const sb = await supabaseServer();
  const opsView = has(staff, "super_admin", "city_admin", "dispatcher", "support", "analyst");
  let tiles: { label: string; value: number | string; href: string; warn?: boolean }[] = [];
  if (opsView) {
    const { cities, global } = await myCities(sb, staff);
    const city = global ? null : cities[0]?.id ?? null;
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);   // Accra = UTC
    const [live, ex, booked, delivered] = await Promise.all([
      sb.rpc("ops_live_map", { p_city: city }),
      sb.rpc("ops_exceptions", { p_city: city }),
      sb.from("orders").select("id", { count: "exact", head: true }).neq("status", "DRAFT").gte("created_at", today.toISOString()),
      sb.from("orders").select("id", { count: "exact", head: true }).in("status", ["DELIVERED", "COLLECTED"]).gte("delivered_at", today.toISOString()),
    ]);
    const riders = ((live.data?.riders ?? []) as { state: string }[]);
    tiles = [
      { label: "Booked today", value: booked.count ?? 0, href: "/orders?view=all" },
      { label: "Delivered today", value: delivered.count ?? 0, href: "/orders?view=done" },
      { label: "Parcels moving now", value: (live.data?.orders ?? []).length, href: "/map" },
      { label: "Riders free", value: riders.filter((r) => r.state === "idle").length, href: "/map" },
      { label: "Riders on a job", value: riders.filter((r) => r.state === "on_job").length, href: "/map" },
      { label: "Exceptions", value: (ex.data ?? []).length, href: "/exceptions", warn: (ex.data ?? []).length > 0 },
    ];
  }
  return (
    <>
      <h1>Akwaaba, {staff.name.split(" ")[0]}</h1>
      {!staff.hasMfa && (
        <div className="card">
          <strong>Protect your account</strong>
          <p className="muted">Switch on two-step verification so a stolen password isn&apos;t enough to get in.</p>
          <Link className="btn small" href="/account/security">Set up 2FA</Link>
        </div>
      )}
      {tiles.length > 0 && <div className="row">{tiles.map((t) => (
        <Link key={t.label} href={t.href} className="card" style={{ textDecoration: "none", color: "inherit", padding: 14, borderColor: t.warn ? "var(--danger)" : undefined }}>
          <div className="muted">{t.label}</div><div style={{ fontSize: 28, fontWeight: 800, color: t.warn ? "var(--danger)" : undefined }}>{t.value}</div>
        </Link>))}</div>}
    </>
  );
}
