import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "@qcs/mobile";
import { act } from "./queue";

export interface Hub { id: string; code: string; name: string; city_id: string }

/** The hubs this person works at, and the one chosen on this phone (remembered). */
export function useHub() {
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [hub, setHubState] = useState<Hub | null>(null);
  useEffect(() => {
    (async () => {
      const { data: ids } = await supabase().rpc("my_hub_ids");
      const list = ((await supabase().from("hubs").select("id, code, name, city_id").in("id", (ids ?? []) as string[]).order("name")).data ?? []) as Hub[];
      setHubs(list);
      const saved = await AsyncStorage.getItem("qcs-hub").catch(() => null);
      setHubState(list.find((h) => h.id === saved) ?? list[0] ?? null);
    })();
  }, []);
  const setHub = useCallback((h: Hub) => { setHubState(h); AsyncStorage.setItem("qcs-hub", h.id).catch(() => {}); }, []);
  return { hubs, hub, setHub };
}

/** A hub scan: saved on the phone first, sent when there's signal (same offline queue as riders). null = waiting for signal. */
export async function hubScan(action: Record<string, unknown>, files?: Parameters<typeof act>[1]) {
  return act({ rpc: "hub_scan", ...action }, files) as Promise<{ ok: boolean; error?: string; [k: string]: unknown } | null>;
}

export const NEXT_TEXT: Record<string, string> = {
  print_label: "→ send to the label desk",
  bag: "→ sort into a bag",
  shelf: "→ collection shelf",
  last_mile: "→ waiting for a delivery rider",
  call_dispatch: "→ tell dispatch",
  ready_for_rider: "→ ready for a rider",
};
