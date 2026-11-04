import { describe, expect, it } from "vitest";
import { ORDER_STATUSES, STATUS_LABELS, etaText, isLive, whatsappLink } from "./index";

describe("tracking helpers", () => {
  it("every status has a friendly label", () => { for (const s of ORDER_STATUSES) expect(STATUS_LABELS[s]).toBeTruthy(); });
  it("ETA text", () => {
    expect([etaText(null), etaText(1), etaText(12), etaText(60), etaText(80)]).toEqual([null, "arriving now", "about 12 min", "about 1 h", "about 1 h 20 min"]);
  });
  it("WhatsApp links use 233…", () => {
    expect(whatsappLink("024 123 4567")).toBe("https://wa.me/233241234567");
    expect(whatsappLink("+233241234567", "Hi")).toBe("https://wa.me/233241234567?text=Hi");
  });
  it("live statuses", () => { expect([isLive("IN_TRANSIT"), isLive("DELIVERED")]).toEqual([true, false]); });
});
