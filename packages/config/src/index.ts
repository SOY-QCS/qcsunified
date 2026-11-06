/** Platform-wide constants. Business values that admins can change live in the database, not here. */
export const TIMEZONE = "Africa/Accra";
export const CURRENCY = "GHS";
export const BRAND_ORANGE = "#df6518";
/** QCS logo blue (background of the logo). */
export const BRAND_BLUE = "#00539F";

/** Cities seeded at launch (codes match `cities.code` in the database). */
export const LAUNCH_CITIES = ["ACC", "KSI", "TKD", "TML"] as const;
export type CityCode = (typeof LAUNCH_CITIES)[number];

/** Defaults only — the live values are admin settings (app_settings) and the server always uses those. */
export const DEFAULT_HIGH_VALUE_PESEWAS = 100_000;  // GHS 1,000
export const DEFAULT_INSURANCE_RATE = 0.05;         // 5% of declared value

/** Tracking number, e.g. ACC-202611041301-KUM (or ...-KUM-02 for a second parcel on that route in the same minute). */
export const TRACKING_NUMBER_RE = /^[A-Z]{2,4}-\d{12}-[A-Z]{2,4}(-\d{2,})?$/;
