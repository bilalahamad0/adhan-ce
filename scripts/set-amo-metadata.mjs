#!/usr/bin/env node
/**
 * Set listing metadata on the AMO (addons.mozilla.org) listing via the API.
 *
 * Why this exists: the Developer Hub form is the documented way to edit listing
 * metadata, but `homepage` is a *translated* field — AMO stores it per-locale as
 * {"en-US": "..."} — and a save that does not stick leaves no error behind. The
 * API is deterministic and reports what the server actually stored.
 *
 * Credentials are the SAME pair `web-ext sign` already uses in
 * release-firefox.yml (repo secrets AMO_JWT_ISSUER / AMO_JWT_SECRET). AMO shows
 * an API secret exactly once at generation time, so the copy in GitHub Actions
 * is the only retrievable one — run this through the "AMO listing metadata"
 * workflow rather than trying to read the secret back out.
 *
 * Env:
 *   AMO_JWT_ISSUER  (required)  JWT issuer from the AMO API key page
 *   AMO_JWT_SECRET  (required)  JWT secret — never logged, never echoed
 *   AMO_SLUG        (optional)  add-on slug, default adhan-caster-prayer-times
 *   AMO_HOMEPAGE    (optional)  URL to store; empty string clears the field
 *   DRY_RUN         (optional)  "true" prints the request and exits
 *
 * No dependencies: the HS256 JWT is built with node:crypto.
 */

import { createHmac, randomUUID } from "node:crypto";

const SLUG = process.env.AMO_SLUG || "adhan-caster-prayer-times";
const HOMEPAGE = process.env.AMO_HOMEPAGE ?? "https://adhan.bilalahamad.com/";
const DRY_RUN = process.env.DRY_RUN === "true";
const API = `https://addons.mozilla.org/api/v5/addons/addon/${SLUG}/`;

const issuer = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;

if (!issuer || !secret) {
  console.error(
    "AMO_JWT_ISSUER / AMO_JWT_SECRET are not set.\n" +
      "In CI these come from the repo secrets of the same names (see RELEASE_SETUP.md)."
  );
  process.exit(1);
}

if (HOMEPAGE && !/^https:\/\/[^\s]+$/.test(HOMEPAGE)) {
  console.error(`Refusing to send a malformed homepage URL: ${JSON.stringify(HOMEPAGE)}`);
  process.exit(1);
}

const b64u = (input) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * AMO requires a short-lived HS256 JWT and rejects an `exp` more than five
 * minutes out. 60s covers one request and keeps a leaked token worthless.
 */
function amoToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64u(JSON.stringify({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 }));
  const sig = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.${sig}`;
}

/** `homepage` is a translated field — a bare string is silently unusable. */
const body = { homepage: { "en-US": HOMEPAGE } };

console.log(`PATCH ${API}`);
console.log(`body  ${JSON.stringify(body)}`);

if (DRY_RUN) {
  console.log("\nDRY_RUN=true — nothing sent.");
  process.exit(0);
}

const res = await fetch(API, {
  method: "PATCH",
  headers: { Authorization: `JWT ${amoToken()}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const text = await res.text();

if (!res.ok) {
  console.error(`\nHTTP ${res.status} ${res.statusText}`);
  console.error(text.slice(0, 1500));
  if (res.status === 401 || res.status === 403) {
    console.error(
      "\nAuth rejected. The credentials must belong to an author of this add-on,\n" +
        "and the runner clock must be accurate — AMO rejects skewed iat/exp."
    );
  }
  process.exit(1);
}

// Trust the read-back, not the 200: confirm what the server actually stored.
const data = JSON.parse(text);
const stored = data.homepage?.url?.["en-US"] ?? data.homepage?.["en-US"] ?? data.homepage ?? null;

console.log(`\nHTTP ${res.status}`);
console.log(`homepage now: ${JSON.stringify(stored)}`);

if (stored !== HOMEPAGE) {
  console.error("\nThe server did not store the value that was sent.");
  process.exit(1);
}
console.log("\nConfirmed — the server stored the value.");
