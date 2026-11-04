import { TrackView } from "@qcs/ui/web";
import { API, MAPS_KEY, Shell } from "../../shell";

export const metadata = { title: "Tracking · QCS Ghana", robots: { index: false } };

/** /track/ACC-202611041301-KUM — status for anyone; map and rider after the last 4 digits of the recipient's phone. */
export default async function TrackOne({ params }: { params: Promise<{ tn: string }> }) {
  const { tn } = await params;
  return (
    <Shell>
      <TrackView apiBase={API} tracking={decodeURIComponent(tn)} mapsKey={MAPS_KEY} />
      <p><a href="/track">Track another parcel</a></p>
    </Shell>
  );
}
