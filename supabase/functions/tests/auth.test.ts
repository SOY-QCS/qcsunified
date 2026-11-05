import assertNode from "node:assert/strict";
import { fromScheduler, sameSecret } from "../_shared/auth.ts";

Deno.test("sameSecret: equal secrets match, anything else does not", () => {
  assertNode.equal(sameSecret("s3cret-value", "s3cret-value"), true);
  assertNode.equal(sameSecret("s3cret-valuX", "s3cret-value"), false);
  assertNode.equal(sameSecret("s3cret", "s3cret-value"), false);       // prefix
  assertNode.equal(sameSecret("s3cret-value-and-more", "s3cret-value"), false);
});

Deno.test("sameSecret: an empty or missing secret never matches (forgotten setting = locked)", () => {
  assertNode.equal(sameSecret("", ""), false);
  assertNode.equal(sameSecret(null, undefined), false);
  assertNode.equal(sameSecret("anything", ""), false);
  assertNode.equal(sameSecret("", "configured"), false);
});

Deno.test("fromScheduler reads the x-qcs-secret header", () => {
  Deno.env.set("QCS_TEST_SECRET", "abc123");
  assertNode.equal(fromScheduler(new Request("http://x", { headers: { "x-qcs-secret": "abc123" } }), "QCS_TEST_SECRET"), true);
  assertNode.equal(fromScheduler(new Request("http://x"), "QCS_TEST_SECRET"), false);
  assertNode.equal(fromScheduler(new Request("http://x", { headers: { "x-qcs-secret": "" } }), "QCS_UNSET_SECRET"), false);
});
