import { bagTagsPdf, labelsPdf, loadLabelOrders, manifestPdf, pdfResponse } from "@qcs/api-client/labels";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * GET /api/hub-docs?labels=id,id  — parcel labels (4×6 thermal)
 *     /api/hub-docs?bags=id,id    — bag tags
 *     /api/hub-docs?manifest=id   — A4 manifest for the bus
 * Printed as the signed-in staff member (the database decides what they may see).
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const sb = await supabaseServer();
  const list = (k: string) => (u.searchParams.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 300);
  try {
    if (list("labels").length) {
      const labels = await loadLabelOrders(sb, list("labels"));
      if (!labels.length) return new Response("Nothing to print", { status: 404 });
      return pdfResponse(await labelsPdf(labels, u.searchParams.get("size") === "a6" ? "a6" : "4x6"), `labels-${labels.length}.pdf`);
    }
    if (list("bags").length) {
      const { data } = await sb.from("hub_bags").select("code, created_at, hub:hubs!hub_bags_hub_id_fkey(code), dest:hubs!hub_bags_dest_hub_id_fkey(code), bag_items(order_id, removed_at)").in("id", list("bags"));
      const one = <T,>(x: T | T[] | null) => (Array.isArray(x) ? x[0] : x) ?? null;
      const tags = (data ?? []).map((b) => ({ code: b.code, created_at: b.created_at, from: one(b.hub as unknown as { code: string })?.code ?? "", to: one(b.dest as unknown as { code: string })?.code ?? "",
        parcels: ((b.bag_items ?? []) as { removed_at: string | null }[]).filter((i) => !i.removed_at).length }));
      if (!tags.length) return new Response("Nothing to print", { status: 404 });
      return pdfResponse(await bagTagsPdf(tags), `bag-tags-${tags.length}.pdf`);
    }
    const mid = u.searchParams.get("manifest");
    if (mid) {
      const { data: m } = await sb.from("manifests").select("*, from:hubs!manifests_origin_hub_id_fkey(code), to:hubs!manifests_dest_hub_id_fkey(code)").eq("id", mid).maybeSingle();
      if (!m) return new Response("Not found", { status: 404 });
      const { data: bags } = await sb.from("hub_bags").select("code, bag_items(removed_at, order:orders(tracking_number))").eq("manifest_id", mid).order("code");
      const one = <T,>(x: T | T[] | null) => (Array.isArray(x) ? x[0] : x) ?? null;
      return pdfResponse(await manifestPdf({ ...m, from: one(m.from)?.code ?? "", to: one(m.to)?.code ?? "",
        bags: (bags ?? []).map((b) => ({ code: b.code, parcels: ((b.bag_items ?? []) as { removed_at: string | null; order: unknown }[]).filter((i) => !i.removed_at)
          .map((i) => one(i.order as { tracking_number: string } | null)?.tracking_number ?? "") })) }), `${m.code}.pdf`);
    }
    return new Response("Say what to print", { status: 400 });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
