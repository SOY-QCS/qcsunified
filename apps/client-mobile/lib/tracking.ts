import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { isFinished, type TrackResult } from "@qcs/types";
import { api } from "./api";

/** Live tracking for one parcel: refreshes every 10 s while it's moving and the app is open. */
export function useTracking(tn: string) {
  const [data, setData] = useState<TrackResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await api<TrackResult>(`/api/v1/track/${encodeURIComponent(tn)}`)); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [tn]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (data?.status && isFinished(data.status)) return;
    const t = setInterval(() => { if (AppState.currentState === "active") load(); }, 10_000);
    return () => clearInterval(t);
  }, [load, data?.status]);
  return { data, error, refresh: load };
}
