import { Shell } from "../../shell";
import { Unsubscribe } from "./unsubscribe";

export const metadata = { title: "Stop offers · QCS Ghana", robots: { index: false } };

/** /u/<token> — the opt-out link at the end of every QCS offer (SMS and email). */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  return <Shell><Unsubscribe token={(await params).token} /></Shell>;
}
