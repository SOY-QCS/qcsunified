/** Platform-wide constants. Business values that admins can change live in the database, not here. */
export const TIMEZONE = "Africa/Accra";
export const CURRENCY = "GHS";
export const BRAND_ORANGE = "#df6518";

/** Cities seeded at launch (codes match `cities.code` in the database). */
export const LAUNCH_CITIES = ["ACC", "KSI", "TKD", "TML"] as const;
export type CityCode = (typeof LAUNCH_CITIES)[number];
