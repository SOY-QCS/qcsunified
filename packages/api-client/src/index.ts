import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type { SupabaseClient };

/**
 * One way for every app to talk to Supabase.
 * Apps pass their own URL + anon key (never the service-role key in an app).
 * Database types will be generated into ./database.types.ts with `supabase gen types` once the schema settles.
 */
export function createQcsClient(url: string, anonKey: string, options?: { storage?: any }) {
  return createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storage: options?.storage },
  });
}

export * as hubtel from "./hubtel";
