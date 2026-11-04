import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { supabase } from "@qcs/mobile";

/**
 * Background location while online (CLAUDE.md §13): every ~12 s on a job, every ~60 s when idle, none when offline.
 * Android shows a permanent "QCS is tracking your trip" notification while this runs — required by Android.
 */
export const LOCATION_TASK = "qcs-rider-location";

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locs = (data as { locations?: Location.LocationObject[] })?.locations ?? [];
  const last = locs[locs.length - 1];
  if (!last) return;
  try {
    await supabase().rpc("rider_ping", { p_lng: last.coords.longitude, p_lat: last.coords.latitude, p_accuracy: last.coords.accuracy ?? null });
  } catch { /* no signal: the next ping will try again */ }
});

export async function startTracking(onJob: boolean): Promise<string | null> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return "Allow location so QCS can send you nearby jobs.";
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (!bg.granted) return "Choose “Allow all the time” for location so jobs keep coming while your screen is off.";
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: onJob ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: onJob ? 12_000 : 60_000,
    distanceInterval: onJob ? 15 : 100,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "QCS is tracking your trip",
      notificationBody: onJob ? "Sharing your location with the customer and dispatch." : "You're online and can receive jobs.",
      notificationColor: "#df6518",
    },
  });
  // send one position straight away so dispatch can see you
  const now = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
  if (now) await supabase().rpc("rider_ping", { p_lng: now.coords.longitude, p_lat: now.coords.latitude, p_accuracy: now.coords.accuracy ?? null });
  return null;
}

export async function stopTracking() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
}

export async function here(): Promise<{ lat: number; lng: number } | null> {
  const p = await Location.getLastKnownPositionAsync().catch(() => null) ?? await Location.getCurrentPositionAsync({}).catch(() => null);
  return p ? { lat: p.coords.latitude, lng: p.coords.longitude } : null;
}
