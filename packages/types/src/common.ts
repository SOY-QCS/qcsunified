import { z } from "zod";

/** Ghana Post GPS digital address, e.g. GA-123-4567. */
export const GhanaPostGps = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}-?\d{3,4}-?\d{4}$/, "Invalid Ghana Post GPS address");

/** Normalise any Ghana phone format to +233XXXXXXXXX; null if invalid. */
export function normalizeGhanaPhone(input: string): string | null {
  const digits = input.replace(/[^\d]/g, "");
  let local: string;
  if (digits.startsWith("233") && digits.length === 12) local = digits.slice(3);
  else if (digits.startsWith("0") && digits.length === 10) local = digits.slice(1);
  else if (digits.length === 9) local = digits;
  else return null;
  if (!/^[235]\d{8}$/.test(local)) return null;
  return `+233${local}`;
}

