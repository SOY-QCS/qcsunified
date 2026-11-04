/** What customers see about a parcel: friendly status words, the tracking answer, rating options. */
import type { OrderStatus } from "./index";

export const STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: "Draft", PENDING_PAYMENT: "Waiting for payment", CONFIRMED: "Booked", SEARCHING_RIDER: "Finding a rider",
  ASSIGNED: "Rider on the way to pickup", RIDER_AT_PICKUP: "Rider at pickup", PICKED_UP: "Picked up", IN_TRANSIT: "On the way",
  AT_HUB: "At the QCS hub", DEPARTED_HUB: "Left the hub", ARRIVED_DEST_HUB: "Arrived at destination hub",
  READY_FOR_COLLECTION: "Ready for collection", COLLECTED: "Collected", OUT_FOR_DELIVERY: "Out for delivery",
  ARRIVED_AT_DROPOFF: "Rider has arrived", DELIVERED: "Delivered",
  CANCELLED: "Cancelled", FAILED_ATTEMPT: "Delivery attempt failed", RESCHEDULED: "Rescheduled",
  RETURNING_TO_SENDER: "Returning to sender", RETURNED: "Returned to sender", LOST: "Lost — claim opened", DAMAGED: "Damaged — claim opened",
};

/** The parcel is moving and a rider is attached: show the map and the rider's contact. */
export const LIVE_STATUSES: readonly OrderStatus[] = ["ASSIGNED", "RIDER_AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "ARRIVED_AT_DROPOFF"];
export const isLive = (s: string) => (LIVE_STATUSES as readonly string[]).includes(s);
export const isFinished = (s: string) => ["DELIVERED", "COLLECTED", "CANCELLED", "RETURNED", "LOST", "DAMAGED"].includes(s);

export interface TrackPoint { lat: number; lng: number }
export interface TrackResult {
  found: boolean;
  locked?: boolean;
  verified?: boolean;
  tracking_number?: string;
  status?: OrderStatus;
  service_type?: string;
  created_at?: string;
  delivered_at?: string | null;
  timeline?: { status: OrderStatus; at: string }[];
  recipient_name?: string;
  dropoff?: TrackPoint & { address: string | null; landmark: string | null };
  pickup?: TrackPoint;
  eta_minutes?: number | null;
  can_rate?: boolean;
  rider?: {
    first_name: string; rating: number; vehicle: string | null; plate: string | null; make_model: string | null;
    photo_url?: string | null; phone: string | null; location: (TrackPoint & { at: string }) | null;
  } | null;
}

/** "about 12 min", "about 1 h 20 min" */
export function etaText(min: number | null | undefined): string | null {
  if (min == null) return null;
  if (min <= 1) return "arriving now";
  if (min < 60) return `about ${min} min`;
  return `about ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

/** Phone to a WhatsApp chat link (wa.me wants digits with the country code). */
export function whatsappLink(phone: string, text = ""): string {
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("0") && d.length === 10) d = "233" + d.slice(1);
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

/** Quick-tap reasons, so most people don't have to type. */
export const RIDER_RATING_TAGS = {
  good: ["On time", "Friendly", "Careful with parcel", "Good communication"],
  bad: ["Late", "Rude", "Parcel damaged", "Didn't call", "Asked for extra money"],
} as const;
export const PICKUP_RATING_TAGS = {
  good: ["Parcel ready", "Easy to find", "Well packed"],
  bad: ["Long wait", "Hard to find", "Badly packed", "Wrong parcel details"],
} as const;
