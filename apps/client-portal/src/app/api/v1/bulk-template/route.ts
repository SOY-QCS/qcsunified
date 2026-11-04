import { bulkTemplateCsv } from "@qcs/types";

/** GET /api/v1/bulk-template — the CSV vendors fill in (opens in Excel or Google Sheets). */
export function GET() {
  return new Response(bulkTemplateCsv(), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="qcs-bulk-upload-template.csv"' },
  });
}
