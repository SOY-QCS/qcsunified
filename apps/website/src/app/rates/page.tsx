import { publicInfo, Shell } from "../shell";
import { RateForm } from "./rate-form";

export const metadata = { title: "Delivery prices · QCS Ghana", description: "Check the price of a QCS delivery: Express, e-commerce and inter-city." };
// Rendered per visit (the data itself is cached for 5 minutes), so a moment when the portal is unreachable is never saved.
export const dynamic = "force-dynamic";

export default async function Rates() {
  const info = await publicInfo();
  return (
    <Shell>
      <h1>Delivery prices</h1>
      <p>Choose where the parcel is picked up and where it goes. You always see the exact price before you confirm a booking.</p>
      {info?.cities.some((c) => c.zones.length)
        ? <RateForm cities={info.cities.filter((c) => c.zones.length).map((c) => ({ code: c.code, name: c.name, zones: c.zones.map((z) => ({ id: z.id, name: z.name })) }))} />
        : <p>Prices can't be shown right now. Please try again in a few minutes, or message us on WhatsApp.</p>}
      <h2 style={{ fontSize: 17, marginTop: 28 }}>Good to know</h2>
      <ul style={{ lineHeight: 1.6 }}>
        <li><strong>Express</strong> is by bike, up to 15 kg. The price is fixed when you book: traffic doesn&apos;t change it.</li>
        <li><strong>E-commerce</strong> is for online shops with a business account: one fixed price per delivery, up to 25 deliveries per trip, with cash on delivery.</li>
        <li><strong>Inter-city</strong> parcels travel between our hubs. The recipient collects at the hub, or we deliver to the door.</li>
        <li>Items worth GHS 1,000 or more can be insured for 5% of their value.</li>
      </ul>
    </Shell>
  );
}
