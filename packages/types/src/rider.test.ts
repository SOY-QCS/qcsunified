import { describe, expect, it } from "vitest";
import { emptyQueue, enqueue, nearestStop, navigationUrl, settle, suggestedRoute, metresBetween } from "./index";

const stops = [
  { id: "legon", status: "IN_TRANSIT", lat: 5.6355, lng: -0.161 },
  { id: "osu", status: "IN_TRANSIT", lat: 5.556, lng: -0.178 },
  { id: "tema", status: "IN_TRANSIT", lat: 5.669, lng: -0.017 },
  { id: "done", status: "DELIVERED", lat: 5.557, lng: -0.179 },
];

describe("next stop", () => {
  it("nearest undelivered stop from where the rider is", () => {
    expect(nearestStop(stops, { lat: 5.56, lng: -0.18 })!.id).toBe("osu");
    expect(nearestStop(stops, { lat: 5.66, lng: -0.03 })!.id).toBe("tema");
  });
  it("delivered stops are skipped; none left = null", () => {
    expect(nearestStop([stops[3]!], { lat: 5.557, lng: -0.179 })).toBeNull();
  });
  it("suggested route walks nearest-next", () => {
    expect(suggestedRoute(stops, { lat: 5.55, lng: -0.18 }).map((s) => s.id)).toEqual(["osu", "legon", "tema"]);
  });
  it("distance", () => expect(metresBetween({ lat: 5.556, lng: -0.178 }, { lat: 5.556, lng: -0.1735 })).toBeGreaterThan(450));
  it("Google Maps link", () => expect(navigationUrl({ lat: 5.6, lng: -0.2 })).toContain("destination=5.6,-0.2"));
});

describe("offline queue", () => {
  const a = { key: "k1", action: { type: "status" }, occurredAt: "2026-11-04T10:00:00Z" };
  it("same action is only queued once", () => expect(enqueue(enqueue(emptyQueue(), a), a).items).toHaveLength(1));
  it("sent OK → removed", () => expect(settle(enqueue(emptyQueue(), a), "k1", { ok: true }).items).toHaveLength(0));
  it("no network → kept for retry", () => {
    const q = settle(enqueue(emptyQueue(), a), "k1", { ok: false, error: new Error("Network request failed") });
    expect(q.items[0]!.attempts).toBe(1);
  });
  it("server refused (e.g. wrong code) → moved to failed with the reason", () => {
    const q = settle(enqueue(emptyQueue(), a), "k1", { ok: false, error: new Error("Collect exactly GHS 100.00") });
    expect(q.items).toHaveLength(0);
    expect(q.failed[0]!.error).toMatch(/Collect exactly/);
  });
});
