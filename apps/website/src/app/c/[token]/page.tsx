import { ConfirmView } from "@qcs/ui/web";
import { API, MAPS_KEY, Shell } from "../../shell";

export const metadata = { title: "Confirm your location · QCS Ghana", robots: { index: false } };

/** /c/<token> — the link in the recipient's SMS/WhatsApp. No login, no app download (CLAUDE.md §10). */
export default async function Confirm({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Shell><ConfirmView apiBase={API} token={token} mapsKey={MAPS_KEY} /></Shell>;
}
