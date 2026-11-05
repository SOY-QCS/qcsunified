import { useLocalSearchParams, useRouter } from "expo-router";
import { Screen, SupportScreen, type SupportParams } from "@qcs/mobile";

/** Help for riders and hub staff, "Report a problem" on a job, and my tickets. */
export default function Support() {
  const p = useLocalSearchParams<SupportParams>();
  const router = useRouter();
  return (
    <Screen>
      <SupportScreen who="rider" p={p} go={(next) => router.push({ pathname: "/support", params: next })}
        back={() => (router.canGoBack() ? router.back() : router.replace("/home"))} />
    </Screen>
  );
}
