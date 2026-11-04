import { VEHICLE_TYPES } from "@qcs/types";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ReviewForm } from "./review-form";

const DOC_LABELS: Record<string, string> = {
  ghana_card: "Ghana Card", drivers_license: "Driver's licence", vehicle_photo: "Vehicle", photo: "Rider photo",
  vehicle_registration: "Vehicle registration", insurance: "Insurance", guarantor_id: "Guarantor ID", roadworthy: "Roadworthy", other: "Other",
};

export default async function RiderApplications() {
  await requireRole(["super_admin", "city_admin"]);
  const sb = await supabaseServer();
  const { data: riders } = await sb.from("riders")
    .select(`id, rider_type, submitted_at, payout_momo_number, payout_momo_network,
             profile:profiles!riders_id_fkey(full_name, phone), city:cities(name),
             vehicle:vehicles!riders_vehicle_id_fkey(type, plate_number, make_model, colour, year),
             guarantor:rider_guarantors(full_name, phone, relationship, address, ghana_card_number),
             docs:rider_documents(id, doc_type, storage_path, number)`)
    .eq("status", "pending").order("submitted_at", { ascending: true });

  // Private files: short-lived links (10 minutes) for reviewing.
  const paths = (riders ?? []).flatMap((r) => (r.docs as { storage_path: string }[]).map((d) => d.storage_path));
  const { data: signed } = paths.length ? await sb.storage.from("kyc").createSignedUrls(paths, 600) : { data: [] };
  const urlFor = new Map((signed ?? []).map((s) => [s.path, s.signedUrl ?? undefined]));

  return (
    <>
      <h1>Rider applications</h1>
      <p className="muted">Oldest first. Check the photos match the person and the documents are readable and in date.</p>
      {(riders ?? []).length === 0 && <div className="card muted">No applications waiting. 🎉</div>}
      {(riders ?? []).map((r) => {
        const p = r.profile as unknown as { full_name: string; phone: string } | null;
        const v = r.vehicle as unknown as { type: string; plate_number: string; make_model: string; colour: string; year: number } | null;
        const g = (Array.isArray(r.guarantor) ? r.guarantor[0] : r.guarantor) as { full_name: string; phone: string; relationship: string; address: string; ghana_card_number: string } | null;
        const docs = r.docs as { id: string; doc_type: string; storage_path: string; number: string | null }[];
        return (
          <div className="card" key={r.id}>
            <div className="row">
              <div>
                <strong>{p?.full_name}</strong> <span className="tag">{(r.city as unknown as { name: string } | null)?.name}</span><br />
                <span className="muted">{p?.phone} · submitted {r.submitted_at ? new Date(r.submitted_at).toLocaleString("en-GH", { timeZone: "Africa/Accra" }) : "—"}</span><br />
                MoMo: {r.payout_momo_number} ({r.payout_momo_network})
              </div>
              <div>
                <strong>Vehicle</strong><br />
                {VEHICLE_TYPES.find((t) => t.value === v?.type)?.label} · {v?.plate_number ?? "no plate"}<br />
                <span className="muted">{[v?.make_model, v?.colour, v?.year].filter(Boolean).join(" · ")}</span>
              </div>
              <div>
                <strong>Guarantor</strong><br />
                {g?.full_name} ({g?.relationship})<br />
                <span className="muted">{g?.phone} · {g?.address}{g?.ghana_card_number ? ` · ${g.ghana_card_number}` : ""}</span>
              </div>
            </div>
            <h2>Documents</h2>
            <div className="docs">
              {docs.map((d) => {
                const url = urlFor.get(d.storage_path);
                return (
                  <a key={d.id} href={url} target="_blank" rel="noreferrer" title={d.number ?? ""}>
                    {url && !d.storage_path.endsWith(".pdf") ? <img src={url} alt={DOC_LABELS[d.doc_type] ?? d.doc_type} /> : <span className="tag">PDF</span>}
                    <div className="muted">{DOC_LABELS[d.doc_type] ?? d.doc_type}{d.number ? ` · ${d.number}` : ""}</div>
                  </a>
                );
              })}
            </div>
            <h2>Decision</h2>
            <ReviewForm riderId={r.id} requestedType={r.rider_type} />
          </div>
        );
      })}
    </>
  );
}
