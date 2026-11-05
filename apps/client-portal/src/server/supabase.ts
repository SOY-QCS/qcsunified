import "server-only";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";

/** Service-role client: used ONLY by the booking server for quotes and create_booking. */
export function serviceClient(): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new ApiError(500, "Booking server is not configured (SUPABASE_SERVICE_ROLE_KEY missing)");
  return createClient(SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: string[], public code?: string) { super(message); }
}

export interface Caller { user: User; db: SupabaseClient }

/**
 * Who is calling? Phone apps send "Authorization: Bearer <token>"; the web portal sends its login cookie.
 * `db` acts as that person, so Row Level Security still applies to everything they read.
 */
export async function caller(req: Request): Promise<Caller> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) throw new ApiError(401, "Please sign in again");
    return { user: data.user, db };
  }
  const db = await supabaseServer();
  const { data } = await db.auth.getUser();
  if (!data.user) throw new ApiError(401, "Please sign in");
  return { user: data.user, db };
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) return Response.json({ error: e.message, details: e.details }, { status: e.status });
  console.error(e);
  return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}
