import { BRAND_BLUE, BRAND_ORANGE } from "@qcs/config";
import { publicInfo, Shell } from "../shell";

export const metadata = { title: "Ride with QCS · QCS Ghana", description: "Become a QCS delivery rider: what you need, how you earn and how to apply in the QCS Rider app." };
// Rendered per visit (the data itself is cached for 5 minutes), so a moment when the portal is unreachable is never saved.
export const dynamic = "force-dynamic";

export default async function Riders() {
  const info = await publicInfo();
  const android = info?.apps.rider_android ?? null;
  const ios = info?.apps.rider_ios ?? null;
  const cities = (info?.cities ?? []).map((c) => c.name);
  return (
    <Shell>
      <h1>Ride with QCS</h1>
      <p>Deliver parcels for QCS in {cities.length > 1 ? `${cities.slice(0, -1).join(", ")} and ${cities.at(-1)}` : cities[0] ?? "Accra, Kumasi, Takoradi and Tamale"}. Get delivery jobs near you, get paid weekly to your MoMo, and cash out early when you need to.</p>

      <h2 style={{ fontSize: 18 }}>Two ways to ride</h2>
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e6e1da", padding: 14 }}>
          <strong style={{ color: BRAND_BLUE }}>Independent rider</strong>
          <p style={{ margin: "6px 0 0" }}>Use your own motorbike, e-bike or vehicle and earn a commission on every delivery.</p>
        </div>
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e6e1da", padding: 14 }}>
          <strong style={{ color: BRAND_BLUE }}>QCS fleet rider</strong>
          <p style={{ margin: "6px 0 0" }}>Ride for QCS and earn a fixed fee for every pickup and every successful delivery.</p>
        </div>
      </div>

      <h2 style={{ fontSize: 18 }}>What you need</h2>
      <ul style={{ lineHeight: 1.7 }}>
        <li>A Ghana Card</li>
        <li>A driver&apos;s licence (not needed for an e-bike)</li>
        <li>A clear photo of yourself and a photo of your vehicle</li>
        <li>A guarantor (someone who vouches for you): their name, phone number and address</li>
        <li>A MoMo number for your pay</li>
        <li>An Android phone or iPhone with mobile data</li>
      </ul>

      <h2 style={{ fontSize: 18 }}>How to apply</h2>
      <ol style={{ lineHeight: 1.7 }}>
        <li>Download the <strong>QCS Rider</strong> app and sign in with your phone number.</li>
        <li>Fill in your details and photograph your documents in the app.</li>
        <li>QCS checks your application and lets you know in the app.</li>
        <li>Once approved, go online in the app and start taking jobs.</li>
      </ol>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
        {android && <a href={android} style={{ background: BRAND_ORANGE, color: "#fff", padding: "12px 18px", borderRadius: 10, fontWeight: 800, textDecoration: "none" }}>Get QCS Rider on Google Play</a>}
        {ios && <a href={ios} style={{ background: BRAND_BLUE, color: "#fff", padding: "12px 18px", borderRadius: 10, fontWeight: 800, textDecoration: "none" }}>Get QCS Rider on the App Store</a>}
      </div>
      {!android && !ios && <p>The QCS Rider app is coming to the stores soon. Visit a <a href="/hubs">QCS hub</a> to register your interest.</p>}
    </Shell>
  );
}
