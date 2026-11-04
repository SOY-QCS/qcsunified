import { Redirect } from "expo-router";
// The root layout decides where to go; this just avoids an empty first screen.
export default function Index() { return <Redirect href="/login" />; }
