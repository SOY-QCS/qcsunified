import { z } from "zod";
import { statementCsv, statementPdf, type StatementRow } from "@/server/statement";
import { ApiError, caller, errorResponse } from "@/server/supabase";

const Q = z.object({ vendor_id: z.uuid(), from: z.iso.date(), to: z.iso.date(), format: z.enum(["csv", "pdf", "json"]).default("pdf") });

/** GET /api/v1/statements?vendor_id=&from=2026-11-01&to=2026-11-30&format=pdf|csv — vendor wallet statement. */
export async function GET(req: Request) {
  try {
    const me = await caller(req);
    const q = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!q.success) throw new ApiError(400, "Choose a business and a date range");
    const { vendor_id, from, to, format } = q.data;
    const { data, error } = await me.db.rpc("vendor_statement", { p_vendor: vendor_id, p_from: from, p_to: to });
    if (error) throw new ApiError(403, error.message);
    const rows = data as StatementRow[];
    if (format === "json") return Response.json({ rows });
    const name = `qcs-statement-${from}-to-${to}`;
    if (format === "csv") {
      return new Response(statementCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` } });
    }
    const { data: v } = await me.db.from("vendors").select("business_name").eq("id", vendor_id).single();
    const pdf = await statementPdf(rows, { businessName: v?.business_name ?? "", from, to, generatedAt: new Date() });
    return new Response(Buffer.from(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${name}.pdf"`, "Cache-Control": "private, no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
