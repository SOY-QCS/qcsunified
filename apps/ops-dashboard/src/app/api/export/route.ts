import { supabaseServer } from "@/lib/supabase/server";

// Column order for each export (the database returns the fields unordered).
const COLUMNS: Record<string, string[]> = {
  journal: ["date", "transaction", "type", "description", "tracking_number", "account", "account_holder", "debit_ghs", "credit_ghs", "hubtel_ref"],
  payouts: ["requested", "paid", "purpose", "payee", "momo", "network", "amount_ghs", "fee_ghs", "status", "reference", "hubtel_ref", "batch", "approved_by", "note"],
  cod: ["collected", "tracking_number", "vendor", "rider", "amount_ghs", "status", "handed_in", "method", "hub", "payout_reference"],
  earnings: ["date", "rider", "phone", "rider_type", "kind", "tracking_number", "description", "amount_ghs"],
};
const KINDS = new Set(Object.keys(COLUMNS));
const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // quote everything that needs it, and stop spreadsheet formulas sneaking in (=, +, -, @ at the start)
  const safe = /^[=@]/.test(s) || (/^[+\-]/.test(s) && !/^[+\-]?[\d.\s]+$/.test(s)) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** GET /api/export?kind=journal&from=2026-11-01&to=2026-11-30 — CSV for the accountant (Finance/analysts; the database checks). */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const kind = u.searchParams.get("kind") ?? "", from = u.searchParams.get("from") ?? "", to = u.searchParams.get("to") ?? "";
  if (!KINDS.has(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return new Response("Choose a type and dates", { status: 400 });
  const sb = await supabaseServer();
  const rows: Record<string, unknown>[] = [];
  for (let page = 0; ; page++) {   // the API returns 1,000 rows at a time
    const { data, error } = await sb.rpc("accounting_export", { p_kind: kind, p_from: from, p_to: to }).range(page * 1000, page * 1000 + 999);
    if (error) return new Response(error.message, { status: 403 });
    rows.push(...((data ?? []) as Record<string, unknown>[]));
    if (!data || data.length < 1000) break;
  }
  const cols = COLUMNS[kind]!;
  const csv = "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="qcs-${kind}-${from}-to-${to}.csv"`, "Cache-Control": "no-store" } });
}
