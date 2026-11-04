import { supabase } from "@qcs/mobile";

/** The QCS booking API (served by the business portal). Set EXPO_PUBLIC_API_URL, e.g. http://192.168.1.20:3001 while testing. */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3001").replace(/\/$/, "");

export class ApiProblem extends Error { constructor(message: string, public details: string[] = []) { super(message); } }

export async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase().auth.getSession();
  return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(await authHeader()), ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiProblem("No internet connection. Check your data or Wi-Fi and try again.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiProblem(body.error ?? `Error ${res.status}`, body.details ?? []);
  return body as T;
}

export interface QuoteResult {
  quote_id: string; expires_at: string;
  stops: { feePesewas: number; netPesewas: number; lines: { label: string; pesewas: number }[] }[];
  subtotalPesewas: number; discountPesewas: number; totalPesewas: number; pickupDate: string | null; notes: string[];
}
export interface BookingResult { trip_id: string | null; needs_payment: boolean; total: number; orders: { id: string; tracking_number: string; status: string; fee: number }[] }
export const ghs = (p: number) => `GHS ${(p / 100).toFixed(2)}`;
