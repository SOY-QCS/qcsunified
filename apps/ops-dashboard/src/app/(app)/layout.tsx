import { navFor, ROLE_LABELS } from "@qcs/types";
import { getStaff } from "@/lib/session";
import { SideNav } from "./side-nav";
import { signOut } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const staff = await getStaff();
  if (!staff) {
    return (
      <main className="auth-wrap">
        <div className="auth-card">
          <h1>No access</h1>
          <p className="muted">This account isn&apos;t set up as QCS staff. Ask a Super Admin or your City Admin to give you a role.</p>
          <form action={signOut}><button className="btn block">Sign out</button></form>
        </div>
      </main>
    );
  }
  const roleText = staff.roles
    .filter((r) => r.role in ROLE_LABELS)
    .map((r) => `${ROLE_LABELS[r.role]}${r.city_code ? ` · ${r.city_code}` : ""}${r.hub_code ? ` · ${r.hub_code}` : ""}`);
  return (
    <div className="shell">
      <SideNav items={navFor(staff.roles)} name={staff.name} roles={roleText} />
      <main className="main">{children}</main>
    </div>
  );
}
