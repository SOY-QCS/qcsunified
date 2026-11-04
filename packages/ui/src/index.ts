import { BRAND_ORANGE } from "@qcs/config";

/** Design tokens shared by web (CSS) and mobile (React Native styles). Components come in later phases. */
export const colors = {
  primary: BRAND_ORANGE,
  primaryDark: "#b8500f",
  text: "#1a1a1a",
  muted: "#6b6b6b",
  surface: "#ffffff",
  background: "#f7f5f2",
  success: "#1f8a4c",
  warning: "#c98a00",
  danger: "#c0392b",
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 16 } as const;
