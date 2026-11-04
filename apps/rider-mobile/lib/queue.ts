import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Network from "expo-network";
import { emptyQueue, enqueue, nextToSend, settle, type Queue, type QueuedAction } from "@qcs/types";
import { supabase } from "@qcs/mobile";

/**
 * Every rider update goes into this queue first, saved on the phone. It's sent straight away when there's
 * signal, and retried automatically when the network comes back. The server ignores repeats (same key),
 * so a retry can never deliver a parcel twice.
 */
const KEY = "qcs-rider-queue";
let queue: Queue = emptyQueue();
let loaded = false;
let sending = false;
const listeners = new Set<(q: Queue) => void>();

async function load() {
  if (loaded) return;
  try { queue = { ...emptyQueue(), ...JSON.parse((await AsyncStorage.getItem(KEY)) ?? "{}") }; } catch { queue = emptyQueue(); }
  loaded = true;
}
async function save() {
  await AsyncStorage.setItem(KEY, JSON.stringify(queue));
  listeners.forEach((l) => l(queue));
}

export function onQueue(l: (q: Queue) => void) { listeners.add(l); l(queue); return () => { listeners.delete(l); }; }

const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
});

/** Queue an action; resolves with the server's answer if it could be sent now, or null if it's waiting for signal. */
export async function act(action: Record<string, unknown>, files?: QueuedAction["files"]): Promise<Record<string, unknown> | null> {
  await load();
  const key = uuid();
  queue = enqueue(queue, { key, action, occurredAt: new Date().toISOString(), files });
  await save();
  return flush(key);
}

async function send(item: QueuedAction): Promise<Record<string, unknown>> {
  const sb = supabase();
  for (const f of item.files ?? []) {
    const body = await (await fetch(f.localUri)).arrayBuffer();
    const { error } = await sb.storage.from("pod").upload(f.path, body, { contentType: f.contentType, upsert: true });
    if (error && !/exists/i.test(error.message)) throw new Error(error.message);
  }
  // rider updates go to rider_action; hub scans (Hub mode) to hub_scan — both ignore repeats of the same key
  const { rpc = "rider_action", ...action } = item.action as { rpc?: string };
  const { data, error } = await sb.rpc(rpc, { p_key: item.key, p_action: action, p_occurred_at: item.occurredAt });
  if (error) throw new Error(error.message);
  return data as Record<string, unknown>;
}

/** Send everything waiting, in order. Returns the answer for `want` if it went through. */
export async function flush(want?: string): Promise<Record<string, unknown> | null> {
  await load();
  if (sending) return null;
  sending = true;
  let answer: Record<string, unknown> | null = null;
  try {
    for (let item = nextToSend(queue); item; item = nextToSend(queue)) {
      const current = item;
      try {
        const res = await send(current);
        if (current.key === want) answer = res;
        queue = settle(queue, current.key, { ok: true });
        await save();
      } catch (e) {
        queue = settle(queue, current.key, { ok: false, error: e });
        await save();
        if (queue.items.some((x) => x.key === current.key)) break;   // no network: stop and wait
        if (current.key === want) throw e;                             // refused: tell the rider now
      }
    }
  } finally {
    sending = false;
  }
  return answer;
}

export async function dismissFailed(key: string) {
  await load();
  queue = { ...queue, failed: queue.failed.filter((f) => f.key !== key) };
  await save();
}

// retry when the app comes back to the front, and every 15 seconds while it's open
AppState.addEventListener("change", (s) => { if (s === "active") flush().catch(() => {}); });
setInterval(async () => {
  const net = await Network.getNetworkStateAsync().catch(() => null);
  if (net?.isInternetReachable !== false) flush().catch(() => {});
}, 15_000);
