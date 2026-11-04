import { redirect } from "next/navigation";

/** The tracking form posts here; send the visitor to the tidy /track/<number> address. */
export function GET(req: Request) {
  const tn = (new URL(req.url).searchParams.get("tn") ?? "").trim().toUpperCase().replace(/\s+/g, "");
  redirect(tn ? `/track/${encodeURIComponent(tn)}` : "/track");
}
