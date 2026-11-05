import { z } from "zod";

/**
 * These lists mirror the Postgres enums in supabase/migrations.
 * If you change one, change the other (the db test checks they match).
 */
export const APP_ROLES = [
  "customer", "vendor_owner", "vendor_staff", "corporate",
  "fleet_rider", "commission_rider", "hub_handler",
  "super_admin", "city_admin", "dispatcher", "hub_manager", "finance", "support", "analyst",
] as const;
export const AppRole = z.enum(APP_ROLES);
export type AppRole = z.infer<typeof AppRole>;

export const SERVICE_TYPES = ["express", "ecommerce", "intercity", "scheduled"] as const;
export const ServiceType = z.enum(SERVICE_TYPES);
export type ServiceType = z.infer<typeof ServiceType>;

export const ORDER_STATUSES = [
  "DRAFT", "PENDING_PAYMENT", "CONFIRMED", "SEARCHING_RIDER", "ASSIGNED",
  "RIDER_AT_PICKUP", "PICKED_UP", "IN_TRANSIT",
  "AT_HUB", "DEPARTED_HUB", "ARRIVED_DEST_HUB", "READY_FOR_COLLECTION", "COLLECTED", "OUT_FOR_DELIVERY",
  "ARRIVED_AT_DROPOFF", "DELIVERED",
  "CANCELLED", "FAILED_ATTEMPT", "RESCHEDULED", "RETURNING_TO_SENDER", "RETURNED", "LOST", "DAMAGED",
] as const;
export const OrderStatus = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const TRIP_STATUSES = ["PLANNED", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export const TripStatus = z.enum(TRIP_STATUSES);
export type TripStatus = z.infer<typeof TripStatus>;

export const PAYER_TYPES = ["sender", "recipient", "vendor_wallet", "corporate_invoice"] as const;
export const PayerType = z.enum(PAYER_TYPES);
export type PayerType = z.infer<typeof PayerType>;

/** Money is always integer pesewas (GHS 1.00 = 100). */
export const Pesewas = z.number().int();
export const toCedis = (p: number) => (p / 100).toFixed(2);

/** Ghana phone number in international format, e.g. +233241234567. */
export const GhanaPhone = z.string().regex(/^\+233\d{9}$/, "Use +233 followed by 9 digits");

export * from "./roles";
export * from "./common";

export const VENDOR_CATEGORIES = [
  "Fashion & clothing", "Electronics & phones", "Food & groceries", "Beauty & cosmetics", "Pharmacy & health",
  "Home & furniture", "Books & stationery", "Restaurant", "Wholesale / distribution", "Other",
] as const;

export const ID_TYPES = [
  { value: "ghana_card", label: "Ghana Card" },
  { value: "business_registration", label: "Business registration certificate" },
  { value: "passport", label: "Passport" },
  { value: "drivers_license", label: "Driver's licence" },
] as const;

export const MOMO_NETWORKS = ["MTN", "Telecel", "AirtelTigo"] as const;

export const VEHICLE_TYPES = [
  { value: "bike", label: "Motorbike" }, { value: "ebike", label: "Electric bike" },
  { value: "tricycle", label: "Tricycle (aboboyaa)" }, { value: "car", label: "Car" }, { value: "van", label: "Van" },
] as const;

export * from "./booking";
export * from "./bulk";
export * from "./rider";
export * from "./tracking";
export * from "./support";
export * from "./business-api";
