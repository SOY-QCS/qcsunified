import { useLocalSearchParams, useRouter } from "expo-router";
import { DeleteAccount, Screen, SupportScreen, type SupportParams } from "@qcs/mobile";

/** Help for riders and hub staff, "Report a problem" on a job, my tickets, and deleting my account. */
export default function Support() {
  const p = useLocalSearchParams<SupportParams>();
  const router = useRouter();
  return (
    <Screen>
      <SupportScreen who="rider" p={p} go={(next) => router.push({ pathname: "/support", params: next })}
        back={() => (router.canGoBack() ? router.back() : router.replace("/home"))} />
      {!Object.keys(p).length && <DeleteAccount />}
    </Screen>
  );
}
