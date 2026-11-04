import type { ExpoConfig, ConfigContext } from "expo/config";

/** Adds the Google Maps key for Android builds from the environment (never committed). iOS uses Apple Maps. */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  android: { ...config.android, config: { ...config.android?.config, googleMaps: { apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY ?? "" } } },
});
