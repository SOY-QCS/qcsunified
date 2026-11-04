import Link from "next/link";
import { navFor } from "@qcs/types";
import { getStaff } from "@/lib/session";

export default async function Overview() {
  const staff = (await getStaff())!;
  const ready = navFor(staff.roles).filter((n) => n.ready && n.href !== "/");
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
      <div className="card">
        <strong>Available now</strong>
        <ul>{ready.map((n) => <li key={n.href}><Link href={n.href}>{n.label}</Link></li>)}</ul>
        <p className="muted">Orders, dispatch, hubs, finance and CRM screens arrive in the next phases.</p>
      </div>
    </>
  );
}
