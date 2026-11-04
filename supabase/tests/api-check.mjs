// Part of api-check.sh. Finds `.from("t").select("...")` and `.rpc("fn", {p_…})` in the apps and tries each one.
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { execSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "../.."); const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.name === "node_modules" || f.name.startsWith(".")) continue;
  const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f.name)) files.push(p); } };
["apps", "packages", "supabase/functions"].forEach((d) => walk(path.join(root, d)));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const head = b64({ alg: "HS256", typ: "JWT" }), body = b64({ role: "service_role", exp: 4102444800 });
const jwt = `${head}.${body}.${crypto.createHmac("sha256", process.env.JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
let bad = 0, n = 0;
for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(/\.from\("([a-z_]+)"\)\s*\.select\((?:"([^"]+)"|`([^`$]+)`)/g)) {
  n++;
  const cols = (m[2] ?? m[3]).replace(/\s+/g, "");
  const r = await fetch(`http://localhost:3901/${m[1]}?limit=1&select=${encodeURIComponent(cols)}`, { headers: { Authorization: `Bearer ${jwt}` } });
  if (!r.ok) { bad++; console.log(`✗ ${path.relative(root, f)}  ${m[1]}: ${(await r.text()).slice(0, 300)}`); }
}
const rows = execSync(`psql "${process.env.DB_URL}" -tAc "select proname || ':' || coalesce(array_to_string(proargnames, ','), '') from pg_proc where pronamespace = 'public'::regnamespace"`).toString().trim().split("\n");
const sig = new Map(); for (const l of rows) { const [k, a] = l.split(":"); (sig.get(k) ?? sig.set(k, []).get(k)).push(a.split(",")); }
let calls = 0;
for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(/rpc(?:Action)?\(\s*"([a-z_]+)"\s*,\s*\{([^}]*)\}/g)) {
  calls++;
  const keys = [...new Set([...m[2].matchAll(/\b(p_[a-z_]+)\b/g)].map((x) => x[1]))];
  const s = sig.get(m[1]);
  if (!s) { bad++; console.log(`✗ ${path.relative(root, f)}  function ${m[1]} does not exist`); }
  else if (!s.some((args) => keys.every((k) => args.includes(k)))) { bad++; console.log(`✗ ${path.relative(root, f)}  ${m[1]} called with ${keys} but takes ${JSON.stringify(s)}`); }
}
console.log(bad ? `❌ ${bad} problem(s)` : `✅ ${n} queries and ${calls} function calls work against the API`);
process.exit(bad ? 1 : 0);
