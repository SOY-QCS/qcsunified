import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { signOut } from "./actions";

const KYC: Record<string, string> = {
  pending: "We're checking your ID. You can already book deliveries.",
  approved: "Business verified ✓",
  rejected: "We couldn't verify your ID — please contact QCS support.",
};

export default async function PortalHome() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data: account } = await sb.rpc("my_account");
  if (!account?.vendor) redirect("/signup");
  return (
    <main className="main" style={{ margin: "0 auto" }}>
      <div className="brand"><span className="brand-mark">Q</span>QCS Business Portal</div>
      <h1>{account.vendor.business_name}</h1>
      <div className="card">{KYC[account.vendor.kyc_status] ?? ""}</div>
      <div className="card"><strong>Coming next</strong><p className="muted">Book single and bulk deliveries (CSV upload), track orders, wallet and statements.</p></div>
      <form action={signOut}><button className="btn secondary">Sign out</button></form>
    </main>
  );
}
