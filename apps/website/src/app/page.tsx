import Link from "next/link";
import { BRAND_BLUE } from "@qcs/config";
import { colors } from "@qcs/ui";
import { Shell } from "./shell";

export default function Home() {
  return (
    <Shell>
      <h1 style={{ color: BRAND_BLUE }}>Quality Courier Services</h1>
      <p>Same-day delivery in Accra, Kumasi, Takoradi and Tamale, and parcels between 20+ cities.</p>
      <h2>Track a parcel</h2>
      <form action="/track/go" method="get" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input name="tn" required placeholder="Tracking number" style={{ flex: 1, minWidth: 200, padding: 12, fontSize: 16, borderRadius: 10, border: "1px solid #ccc" }} />
        <button style={{ padding: "12px 18px", borderRadius: 10, border: 0, background: colors.primary, color: "#fff", fontWeight: 800 }}>Track</button>
      </form>
      <h2>How much does it cost?</h2>
      <p><Link href="/rates">Check a price</Link> for Express, e-commerce and inter-city delivery.</p>
      <h2>Our hubs</h2>
      <p><Link href="/hubs">Addresses and opening hours</Link> of our hubs in Accra, Kumasi, Takoradi and Tamale.</p>
      <h2>Ride with QCS</h2>
      <p><Link href="/riders">Become a rider</Link>: what you need and how you earn.</p>
      <h2>Questions?</h2>
      <p><Link href="/help">Help centre</Link>: prices, delivery codes, cash on delivery, inter-city and claims.</p>
    </Shell>
  );
}
