import { describe, expect, it } from "vitest";
import { checkTransactionStatus, fromCedis, initiateCheckout, momoChannel, parseCheckoutCallback, parsePayoutCallback, sameSecret, sendMoney, toCedis, type HubtelConfig } from "./hubtel";

const cfg: HubtelConfig = { apiId: "id", apiKey: "key", merchantAccount: "11684", checkoutUrl: "https://payproxyapi.hubtel.com/items/initiate",
  statusUrl: "https://api-txnstatus.hubtel.com/transactions/{merchant}/status", sendMoneyUrl: "https://smp.hubtel.com/api/merchants/2017101/send/mobilemoney" };
const fake = (status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) =>
  (async (url: string, init?: RequestInit) => { seen.url = url; seen.init = init; return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;

describe("money conversion", () => {
  it("pesewas ↔ cedis", () => { expect(toCedis(4650)).toBe(46.5); expect(fromCedis("46.50")).toBe(4650); expect(fromCedis(0.1 + 0.2)).toBe(30); });
});

describe("checkout", () => {
  it("sends amount in cedis with Basic auth and returns the checkout link", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const r = await initiateCheckout(cfg, { amountPesewas: 4650, description: "QCS delivery", clientReference: "QCS2611041301ABCDEF12",
      callbackUrl: "https://x/cb", returnUrl: "https://x/r", cancellationUrl: "https://x/c" },
      fake(200, { responseCode: "0000", status: "Success", data: { checkoutId: "chk", checkoutUrl: "https://pay.hubtel.com/chk", checkoutDirectUrl: "https://pay.hubtel.com/chk/direct" } }, seen));
    expect(r.checkoutUrl).toBe("https://pay.hubtel.com/chk");
    const sent = JSON.parse(seen.init!.body as string);
    expect(sent).toMatchObject({ totalAmount: 46.5, merchantAccountNumber: "11684", clientReference: "QCS2611041301ABCDEF12" });
    expect((seen.init!.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("id:key")}`);
  });
  it("refuses references over 32 characters", async () => {
    await expect(initiateCheckout(cfg, { amountPesewas: 1, description: "x", clientReference: "x".repeat(33), callbackUrl: "", returnUrl: "", cancellationUrl: "" }, fake(200, {}))).rejects.toThrow(/32/);
  });
  it("Hubtel errors are reported", async () => {
    await expect(initiateCheckout(cfg, { amountPesewas: 1, description: "x", clientReference: "r", callbackUrl: "", returnUrl: "", cancellationUrl: "" },
      fake(400, { responseCode: "4000", data: { message: "Invalid merchant" } }))).rejects.toThrow(/Invalid merchant/);
  });
});

describe("callbacks", () => {
  const paid = { ResponseCode: "0000", Status: "Success", Data: { CheckoutId: "chk", SalesInvoiceId: "inv-1", ClientReference: "QCSREF", Status: "Success",
    Amount: 46.5, CustomerPhoneNumber: "233244000301", PaymentDetails: { MobileMoneyNumber: "233244000301", PaymentType: "mobilemoney", Channel: "mtn-gh" } } };
  it("reads a successful payment", () => {
    expect(parseCheckoutCallback(paid)).toMatchObject({ clientReference: "QCSREF", checkoutId: "chk", outcome: "paid", amountPesewas: 4650, phone: "233244000301", channel: "mtn-gh" });
  });
  it("failed payment", () => expect(parseCheckoutCallback({ ResponseCode: "2001", Data: { ClientReference: "R", Status: "Failed" } })?.outcome).toBe("failed"));
  it("rubbish is ignored", () => { expect(parseCheckoutCallback({ hello: 1 })).toBeNull(); expect(parseCheckoutCallback(null)).toBeNull(); });
  it("same message → same dedupe key; different status → different key", () => {
    expect(parseCheckoutCallback(paid)!.dedupeKey).toBe(parseCheckoutCallback(structuredClone(paid))!.dedupeKey);
    expect(parseCheckoutCallback(paid)!.dedupeKey).not.toBe(parseCheckoutCallback({ ...paid, ResponseCode: "2001" })!.dedupeKey);
  });
  it("payout callback", () => {
    expect(parsePayoutCallback({ ResponseCode: "0000", Data: { ClientReference: "W1", TransactionId: "t" } })?.outcome).toBe("paid");
    expect(parsePayoutCallback({ ResponseCode: "2050", Data: { ClientReference: "W1", Description: "Not registered" } })?.message).toBe("Not registered");
  });
  it("secret comparison", () => { expect(sameSecret("abc", "abc")).toBe(true); expect(sameSecret("abc", "abd")).toBe(false); expect(sameSecret("", "")).toBe(false); });
});

describe("status check and send money", () => {
  it("status check is optional", async () => expect(await checkTransactionStatus({ ...cfg, statusUrl: null }, "R")).toBeNull());
  it("status check reads Paid", async () => {
    const seen: { url?: string } = {};
    const r = await checkTransactionStatus(cfg, "QCS REF", fake(200, { responseCode: "0000", data: { status: "Paid", amount: 46.5, transactionId: "t" } }, seen));
    expect(r).toMatchObject({ outcome: "paid", amountPesewas: 4650 });
    expect(seen.url).toBe("https://api-txnstatus.hubtel.com/transactions/11684/status?clientReference=QCS%20REF");
  });
  it("send money maps networks and treats 0001 as accepted", async () => {
    const seen: { init?: RequestInit } = {};
    const r = await sendMoney(cfg, { clientReference: "W1", amountPesewas: 1500, msisdn: "+233244000301", network: "Telecel", recipientName: "Ama", description: "QCS wallet", callbackUrl: "https://x" },
      fake(200, { ResponseCode: "0001", Data: { TransactionId: "t" } }, seen));
    expect(r.accepted).toBe(true);
    expect(JSON.parse(seen.init!.body as string)).toMatchObject({ Channel: "vodafone-gh", RecipientMsisdn: "233244000301", Amount: 15 });
    expect(momoChannel("MTN")).toBe("mtn-gh"); expect(momoChannel("AirtelTigo")).toBe("tigo-gh");
  });
});
