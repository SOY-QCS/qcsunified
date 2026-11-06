import { BRAND_BLUE } from "@qcs/config";
import { publicInfo, Shell, type PublicHub } from "../shell";

export const metadata = { title: "QCS hubs · QCS Ghana", description: "Addresses, phone numbers and opening hours of the QCS hubs in Accra, Kumasi, Takoradi and Tamale." };
// Rendered per visit (the data itself is cached for 5 minutes), so a moment when the portal is unreachable is never saved.
export const dynamic = "force-dynamic";

const DAYS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]] as const;

function Hours({ hours }: { hours: PublicHub["opening_hours"] }) {
  return (
    <table style={{ borderCollapse: "collapse", fontSize: 14, marginTop: 8 }}>
      <tbody>
        {DAYS.map(([k, label]) => (
          <tr key={k}>
            <td style={{ padding: "2px 16px 2px 0", color: "#6b6b6b" }}>{label}</td>
            <td>{hours?.[k] ? `${hours[k][0]}–${hours[k][1]}` : "Closed"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function Hubs() {
  const info = await publicInfo();
  const cities = (info?.cities ?? []).filter((c) => c.hubs.length);
  return (
    <Shell>
      <h1>Our hubs</h1>
      <p>Drop off or collect inter-city parcels at any QCS hub. Bring the collection code we send to the recipient by SMS or WhatsApp.</p>
      {!info && <p>The hub list can&apos;t be shown right now. Please try again in a few minutes.</p>}
      {cities.map((c) => (
        <section key={c.code} id={c.code} style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>{c.name}</h2>
          {c.hubs.map((h) => (
            <article key={h.id} id={h.code} style={{ background: "#fff", borderRadius: 14, border: "1px solid #e6e1da", padding: 14, marginBottom: 10 }}>
              <strong style={{ color: BRAND_BLUE, fontSize: 16 }}>{h.name}</strong>
              <div style={{ marginTop: 4 }}>{h.address}</div>
              {h.phone && <div style={{ marginTop: 4 }}><a href={`tel:${h.phone.replace(/\s/g, "")}`}>{h.phone}</a></div>}
              <Hours hours={h.opening_hours} />
              <p style={{ margin: "10px 0 0" }}>
                <a href={`https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}`} target="_blank" rel="noopener noreferrer">Directions in Google Maps</a>
              </p>
            </article>
          ))}
        </section>
      ))}
    </Shell>
  );
}
