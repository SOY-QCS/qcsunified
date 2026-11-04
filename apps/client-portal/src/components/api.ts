"use client";
/** Calls to our own booking API (same website, so the login cookie goes along automatically). */
export class ApiProblem extends Error { constructor(message: string, public details: string[] = []) { super(message); } }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiProblem(body.error ?? `Error ${res.status}`, body.details ?? []);
  return body as T;
}

export interface QuoteResult {
  quote_id: string; expires_at: string; city: string;
  stops: { feePesewas: number; netPesewas: number; lines: { label: string; pesewas: number }[] }[];
  subtotalPesewas: number; discountPesewas: number; totalPesewas: number; pickupDate: string | null; notes: string[];
}
export interface BookingResult { trip_id: string | null; needs_payment: boolean; total: number; orders: { id: string; tracking_number: string; status: string; fee: number }[] }

export const ghs = (p: number) => `GHS ${(p / 100).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
