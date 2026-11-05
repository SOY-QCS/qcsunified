import { openApi } from "@/server/business/openapi";

/** GET /api/business/v1/openapi.json — machine-readable API description (public; import it into Postman or Insomnia). */
export function GET(req: Request) {
  const base = process.env.PUBLIC_API_URL || new URL(req.url).origin;
  return Response.json(openApi(base), { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
}
