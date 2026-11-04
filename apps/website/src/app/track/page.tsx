import { colors } from "@qcs/ui";
import { Shell } from "../shell";

export const metadata = { title: "Track a parcel · QCS Ghana" };

/** /track — type a tracking number. Plain form, works without JavaScript. */
export default function Track() {
  return (
    <Shell>
      <h1>Track your parcel</h1>
      <form action="/track/go" method="get" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input name="tn" required placeholder="e.g. ACC-202611041301-KUM" autoCapitalize="characters"
          style={{ flex: 1, minWidth: 220, padding: 12, fontSize: 16, borderRadius: 10, border: "1px solid #ccc" }} />
        <button style={{ padding: "12px 18px", borderRadius: 10, border: 0, background: colors.primary, color: "#fff", fontWeight: 800, fontSize: 16 }}>Track</button>
      </form>
      <p style={{ color: colors.muted }}>The tracking number is in your SMS or on the parcel label.</p>
    </Shell>
  );
}
