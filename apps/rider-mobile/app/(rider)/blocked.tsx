import { Button, Screen, Title, supabase } from "@qcs/mobile";

export default function Blocked() {
  return (
    <Screen>
      <Title sub="Please contact QCS operations for help.">Your account is paused</Title>
      <Button title="Sign out" kind="secondary" onPress={() => supabase().auth.signOut()} />
    </Screen>
  );
}
