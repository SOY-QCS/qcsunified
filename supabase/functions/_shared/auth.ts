/**
 * Secret checks shared by every Edge Function.
 * Compares in constant time (so response timing gives no hints), and never accepts an empty secret
 * (so a forgotten server setting means "locked", not "open").
 */
export function sameSecret(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i % (a.length || 1)] ?? 0) ^ b[i]!;
  return diff === 0;
}

/** True when the request carries our scheduler's secret in "x-qcs-secret". */
export function fromScheduler(req: Request, secretName: string): boolean {
  return sameSecret(req.headers.get("x-qcs-secret"), Deno.env.get(secretName));
}
