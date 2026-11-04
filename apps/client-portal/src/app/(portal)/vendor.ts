import "server-only";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import type { InsuranceInfo, VendorInfo } from "@/components/booking-form";

/** The signed-in vendor, their default pickup and the person's own name/phone. */
export async function currentVendor(): Promise<{ vendor: VendorInfo; me: { name: string; phone: string }; insurance: InsuranceInfo }> {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data: account } = await sb.rpc("my_account");
  if (!account?.vendor) redirect("/signup");
  const { data: v } = await sb.from("vendors").select("id, business_name, account_type, default_pickup_address_id").eq("id", account.vendor.id).single();
  const { data: a } = v?.default_pickup_address_id
    ? await sb.from("addresses").select("id, formatted_address, lat, lng, ghana_post_gps, landmark, contact_name, contact_phone").eq("id", v.default_pickup_address_id).single()
    : { data: null };
  const { data: ins } = await sb.from("app_settings").select("key, value").in("key", ["insurance_rate", "high_value_threshold"]).is("city_id", null);
  const val = (k: string, d: number) => Number(ins?.find((x) => x.key === k)?.value ?? d) || d;
  return {
    insurance: { rate: val("insurance_rate", 0.05), threshold: val("high_value_threshold", 100000) },
    vendor: {
      id: v!.id, name: v!.business_name, accountType: v!.account_type,
      pickup: a ? { address_id: a.id, formatted_address: a.formatted_address, lat: a.lat, lng: a.lng, ghana_post_gps: a.ghana_post_gps ?? "", landmark: a.landmark ?? "",
                    contact_name: a.contact_name ?? account.profile?.full_name ?? "", contact_phone: a.contact_phone ?? (user.phone ? `+${user.phone.replace(/^\+/, "")}` : "") } : null,
    },
    me: { name: account.profile?.full_name ?? "", phone: user.phone ? `+${user.phone.replace(/^\+/, "")}` : "" },
  };
}
