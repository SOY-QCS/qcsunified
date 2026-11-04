import { TrackView } from "@qcs/ui/web";

/** One order, live: map, rider, arrival estimate, history and (after delivery) the rider rating. */
export default async function OrderPage({ params }: { params: Promise<{ tn: string }> }) {
  const { tn } = await params;
  return (
    <>
      <p><a href="/orders">← Orders</a></p>
      <h1>Track {decodeURIComponent(tn)}</h1>
      <div style={{ maxWidth: 640 }}>
        <TrackView apiBase="" tracking={decodeURIComponent(tn)} mapsKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY} askForCode={false}
          rateUrl="/api/v1/ratings" credentials="include" />
      </div>
    </>
  );
}
