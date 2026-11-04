import Link from "next/link";
import { currentVendor } from "./vendor";
import { supabaseServer } from "@/lib/supabase/server";

const KYC: Record<string, string> = {
  pending: "We're checking your ID. You can already book deliveries.",
  approved: "Business verified ✓",
  rejected: "We couldn't verify your ID — please contact QCS support.",
};

export default async function PortalHome() {
  const { vendor } = await currentVendor();
  const sb = await supabaseServer();
  const { data: v } = await sb.from("vendors").select("kyc_status").eq("id", vendor.id).single();
  return (
    <>
      <h1>{vendor.name}</h1>
      <div className="card">{KYC[v?.kyc_status ?? ""] ?? ""}</div>
      <div className="row">
        <Link className="card" href="/book" style={{ textDecoration: "none", color: "inherit" }}><strong>Book a delivery →</strong><p className="muted">Express now, or an e-commerce trip of up to 25 drop-offs.</p></Link>
        <Link className="card" href="/bulk" style={{ textDecoration: "none", color: "inherit" }}><strong>Bulk upload →</strong><p className="muted">Upload a CSV or Excel file of orders. We check every row.</p></Link>
      </div>
    </>
  );
}
