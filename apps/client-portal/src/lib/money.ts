/** Pesewas → "GHS 12.50". Plain helper: safe on the server and in the browser. */
export const ghs = (p: number) => `GHS ${(p / 100).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
