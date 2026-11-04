import { describe, expect, it } from "vitest";
import { handleCheckoutCallback, type CallbackDeps } from "./payments";

const paid = { ResponseCode: "0000", Status: "Success", Data: { CheckoutId: "chk", SalesInvoiceId: "inv", ClientReference: "REF", Status: "Success", Amount: 30,
  PaymentDetails: { MobileMoneyNumber: "233244000301", Channel: "mtn-gh" } } };

function deps(o: Partial<CallbackDeps> = {}) {
  const log: string[] = [];
  const seen = new Set<string>();
  const d: CallbackDeps = {
    expectedToken: "s3cret",
    record: async (_r, k) => { if (seen.has(k)) return false; seen.add(k); return true; },
    statusCheck: async () => null,
    settle: async (ref, chk, amt) => { log.push(`settle ${ref} ${chk} ${amt}`); return "settled"; },
    fail: async (ref) => { log.push(`fail ${ref}`); },
    ...o,
  };
  return { d, log };
}

describe("Hubtel checkout callback", () => {
  it("good callback settles the payment once", async () => {
    const { d, log } = deps();
    expect(await handleCheckoutCallback("s3cret", paid, d)).toEqual({ status: 200, outcome: "settled" });
    expect(await handleCheckoutCallback("s3cret", paid, d)).toEqual({ status: 200, outcome: "duplicate" });
    expect(log).toEqual(["settle REF chk 3000"]);
  });
  it("forged callback without our secret is refused and changes nothing", async () => {
    const { d, log } = deps();
    expect((await handleCheckoutCallback("guess", paid, d)).status).toBe(401);
    expect((await handleCheckoutCallback(null, paid, d)).status).toBe(401);
    expect(log).toEqual([]);
  });
  it("if Hubtel's status check says unpaid, we don't credit", async () => {
    const { d, log } = deps({ statusCheck: async () => ({ outcome: "unpaid", amountPesewas: null, transactionId: null, channel: null }) });
    expect((await handleCheckoutCallback("s3cret", paid, d)).outcome).toBe("not_confirmed_unpaid");
    expect(log).toEqual([]);
  });
  it("status check amount wins over the callback amount", async () => {
    const { d, log } = deps({ statusCheck: async () => ({ outcome: "paid", amountPesewas: 2999, transactionId: "t", channel: null }) });
    await handleCheckoutCallback("s3cret", paid, d);
    expect(log).toEqual(["settle REF chk 2999"]);
  });
  it("failed payment is recorded", async () => {
    const { d, log } = deps();
    await handleCheckoutCallback("s3cret", { ResponseCode: "2001", Data: { ClientReference: "REF", Status: "Failed" } }, d);
    expect(log).toEqual(["fail REF"]);
  });
  it("database refusal (e.g. wrong amount) is reported, not crashed", async () => {
    const { d } = deps({ settle: async () => { throw new Error("Amount mismatch on payment REF"); } });
    expect((await handleCheckoutCallback("s3cret", paid, d)).outcome).toMatch(/rejected: Amount mismatch/);
  });
  it("unreadable body", async () => expect((await handleCheckoutCallback("s3cret", "hello", deps().d)).status).toBe(400));
});
