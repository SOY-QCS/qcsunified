import { BRAND_BLUE } from "@qcs/config";

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
export const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;

const NAV = [["/track", "Track"], ["/rates", "Prices"], ["/hubs", "Hubs"], ["/riders", "Ride with QCS"], ["/help", "Help"]] as const;

/** Simple page frame for the public pages (phone-first). */
export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header style={{ background: BRAND_BLUE, color: "#fff" }}>
        <div style={{ maxWidth: 640, margin: "0 auto", padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <a href="/" aria-label="QCS Ghana home" style={{ display: "block", lineHeight: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/qcs-logo.png" alt="QCS" width={110} height={44} style={{ display: "block" }} />
          </a>
          <nav style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 15, fontWeight: 700 }}>
            {NAV.map(([href, label]) => <a key={href} href={href} style={{ color: "#fff", textDecoration: "none" }}>{label}</a>)}
          </nav>
        </div>
      </header>
      <main style={{ maxWidth: 640, margin: "0 auto", padding: 16 }}>{children}</main>
      <footer style={{ maxWidth: 640, margin: "24px auto 0", padding: "12px 16px 32px", fontSize: 13, color: "#6b6b6b", display: "flex", gap: 16, flexWrap: "wrap" }}>
        <a href="/help" style={{ color: "inherit" }}>Help</a>
        <a href="/privacy" style={{ color: "inherit" }}>Privacy</a>
        <a href="/delete-account" style={{ color: "inherit" }}>Delete your account</a>
      </footer>
    </>
  );
}

export interface PublicHub { id: string; code: string; name: string; address: string; phone: string | null; opening_hours: Record<string, [string, string]>; lat: number; lng: number }
export interface PublicCity { code: string; name: string; cutoff: string; zones: { id: string; name: string }[]; hubs: PublicHub[] }
export interface PublicInfo { cities: PublicCity[]; apps: Record<string, string | null> }

/** Cities, areas, hubs and app links from the portal (cached 5 minutes). Null when it can't be reached. */
export async function publicInfo(): Promise<PublicInfo | null> {
  try {
    const r = await fetch(`${API}/api/v1/public`, { next: { revalidate: 300 } });
    return r.ok ? ((await r.json()) as PublicInfo) : null;
  } catch { return null; }
}
