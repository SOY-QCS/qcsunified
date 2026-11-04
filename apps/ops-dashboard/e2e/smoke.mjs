// Smoke test: the dashboard must keep signed-out visitors out and show the login pages.
// Run against a started dashboard: BASE_URL=http://localhost:3000 node e2e/smoke.mjs
import { createRequire } from "node:module";
// Uses the Playwright installed on this machine (npm i -g playwright && npx playwright install chromium).
const { chromium } = createRequire(import.meta.url)("playwright");

const base = process.env.BASE_URL ?? "http://localhost:3000";
const checks = [];
const ok = (cond, label) => { checks.push(label); if (!cond) throw new Error(`FAIL: ${label}`); console.log(`ok  ${label}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // phone-sized
try {
  await page.goto(`${base}/users`);
  ok(page.url().includes("/login?next=%2Fusers"), "signed-out visitor sent to login (and back to the page after)");
  ok(await page.getByRole("button", { name: "Sign in" }).isVisible(), "login form shows");
  await page.getByRole("button", { name: "Phone" }).click();
  ok(await page.getByLabel("Phone number").isVisible(), "can switch to phone + password");
  await page.getByLabel("Phone number").fill("12");
  await page.getByLabel("Password").fill("x");
  await page.getByRole("button", { name: "Sign in" }).click();
  ok(await page.getByText("Enter a Ghana phone number").isVisible(), "bad phone number explained in plain words");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await page.waitForURL("**/forgot-password");
  ok(await page.getByRole("button", { name: "Send reset link" }).isVisible(), "forgot password page (email)");
  await page.getByRole("button", { name: "SMS code" }).click();
  ok(await page.getByRole("button", { name: "Text me a code" }).isVisible(), "forgot password page (SMS code)");
  const manifest = await (await page.request.get(`${base}/manifest.webmanifest`)).json();
  ok(manifest.theme_color === "#df6518" && manifest.icons.length >= 2, "installable app manifest with QCS orange");
  ok((await page.request.get(`${base}/icon-512.png`)).ok(), "app icon served");
} finally {
  await browser.close();
}
console.log(`✅ ${checks.length} dashboard smoke checks passed`);
