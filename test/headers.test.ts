import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifySurface,
  COOP_REPORT_ONLY,
  CSP_REPORT_ONLY_NON_HTML,
  HSTS,
  PERMISSIONS_POLICY,
  REPORT_PATH,
  securityHeadersFor,
  withSecurityHeaders,
} from "../src/headers.ts";

// The offline half of batch-two item 8. The live half is gate 6 in
// scripts/verify-live.mjs; this one runs with no network and is what CI checks
// on every push.
//
// These assert the CLASSES, not a list of paths. A path list would pass happily
// on the day a fourteenth response exit appears, which is the exact shape
// capsid/conventions.md rules against.

test("classifySurface maps every content type capsid actually emits", () => {
  assert.equal(classifySurface("text/html;charset=utf-8"), "html");
  assert.equal(classifySurface("application/json"), "json");
  // The provider and the MCP handler both emit +json suffix types.
  assert.equal(classifySurface("application/problem+json"), "json");
  assert.equal(classifySurface("application/reports+json"), "json");
  assert.equal(classifySurface("text/plain;charset=UTF-8"), "other");
  assert.equal(classifySurface("text/event-stream"), "other");
  // Measured on the live worker: the provider's /mcp 401 carries NO
  // Content-Type at all. It must still be classified, not crash.
  assert.equal(classifySurface(null), "other");
});

test("case does not change the class", () => {
  assert.equal(classifySurface("TEXT/HTML"), "html");
  assert.equal(classifySurface("Application/JSON"), "json");
});

test("HTML carries the six enforced headers", () => {
  const h = securityHeadersFor("html");
  assert.equal(h["Strict-Transport-Security"], HSTS);
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Referrer-Policy"], "no-referrer");
  assert.equal(h["X-Frame-Options"], "DENY");
  assert.equal(h["Permissions-Policy"], PERMISSIONS_POLICY);
  // The seventh is on trial, not enforced. Ruled 2026-08-12.
  assert.equal(h["Cross-Origin-Opener-Policy-Report-Only"], COOP_REPORT_ONLY);
  assert.equal(h["Cross-Origin-Opener-Policy"], undefined);
});

test("JSON carries nosniff and HSTS, and no enforced CSP", () => {
  const h = securityHeadersFor("json");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Strict-Transport-Security"], HSTS);
  assert.equal(h["Content-Security-Policy-Report-Only"], CSP_REPORT_ONLY_NON_HTML);
  assert.equal(h["Content-Security-Policy"], undefined);
});

test("every class gets HSTS and nosniff, with no exception", () => {
  for (const cls of ["html", "json", "other"] as const) {
    const h = securityHeadersFor(cls);
    assert.equal(h["Strict-Transport-Security"], HSTS, `${cls} lost HSTS`);
    assert.equal(h["X-Content-Type-Options"], "nosniff", `${cls} lost nosniff`);
  }
});

// The load-bearing assertion for item 9. If a future change promotes either
// trial policy to enforced without a ruling, this fails by name.
test("NOTHING is enforced that is meant to be Report-Only", () => {
  for (const cls of ["html", "json", "other"] as const) {
    const h = securityHeadersFor(cls);
    assert.equal(h["Cross-Origin-Opener-Policy"], undefined, `${cls} enforces COOP without a ruling`);
    // The consent dialog sets its own enforced CSP in github-handler.ts and that
    // one is ruled. This layer must never add an enforced CSP of its own.
    assert.equal(h["Content-Security-Policy"], undefined, `${cls} enforces a CSP from the header layer`);
  }
});

test("the report-only policies point at the report sink", () => {
  assert.match(CSP_REPORT_ONLY_NON_HTML, new RegExp(`report-uri ${REPORT_PATH}`));
  assert.match(CSP_REPORT_ONLY_NON_HTML, /report-to csp/);
  for (const cls of ["json", "other"] as const) {
    assert.equal(securityHeadersFor(cls)["Reporting-Endpoints"], `csp="${REPORT_PATH}"`);
  }
});

test("form-action appears in no policy this layer emits", () => {
  // e7a0dff removed form-action from the consent CSP after it broke the OAuth
  // redirect chain for 26 days. It must not reappear anywhere, including in a
  // Report-Only policy that could later be promoted.
  for (const cls of ["html", "json", "other"] as const) {
    for (const value of Object.values(securityHeadersFor(cls))) {
      assert.doesNotMatch(value, /form-action/, `${cls} names form-action`);
    }
  }
});

test("withSecurityHeaders preserves headers that are already set", () => {
  // The consent dialog's own CSP, nosniff, Referrer-Policy and X-Frame-Options
  // must survive untouched. This is the batch-one Cache-Control rule.
  const consentCsp = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
  const original = new Response("<!doctype html>", {
    status: 200,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Content-Security-Policy": consentCsp,
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
    },
  });
  const out = withSecurityHeaders(original);
  assert.equal(out.headers.get("Content-Security-Policy"), consentCsp);
  assert.equal(out.headers.get("X-Frame-Options"), "DENY");
  // and the missing three are added
  assert.equal(out.headers.get("Strict-Transport-Security"), HSTS);
  assert.equal(out.headers.get("Permissions-Policy"), PERMISSIONS_POLICY);
  assert.equal(out.headers.get("Cross-Origin-Opener-Policy-Report-Only"), COOP_REPORT_ONLY);
});

test("withSecurityHeaders does not overwrite a deliberately different value", () => {
  // Every header here IS in the html set, and every value differs from the
  // default. That combination is the only one that can detect a preserve bug.
  //
  // The first version of this test used a JSON response and Referrer-Policy,
  // which is not in the json set at all, and asserted values in the html case
  // that happened to equal the defaults. A planted "overwrite everything" bug
  // stayed GREEN against it. Found by planting, not by review.
  const original = new Response("<!doctype html>", {
    status: 200,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Referrer-Policy": "origin-when-cross-origin",
      "X-Frame-Options": "SAMEORIGIN",
      "Permissions-Policy": "camera=(self)",
      "Strict-Transport-Security": "max-age=60",
      "X-Content-Type-Options": "nosniff-but-different",
    },
  });
  const out = withSecurityHeaders(original);
  assert.equal(out.headers.get("Referrer-Policy"), "origin-when-cross-origin");
  assert.equal(out.headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(out.headers.get("Permissions-Policy"), "camera=(self)");
  assert.equal(out.headers.get("Strict-Transport-Security"), "max-age=60");
  assert.equal(out.headers.get("X-Content-Type-Options"), "nosniff-but-different");
});

test("withSecurityHeaders preserves status, statusText and body", async () => {
  const original = new Response("not found", {
    status: 404,
    statusText: "Not Found",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
  });
  const out = withSecurityHeaders(original);
  assert.equal(out.status, 404);
  assert.equal(out.statusText, "Not Found");
  assert.equal(await out.text(), "not found");
  assert.equal(out.headers.get("X-Content-Type-Options"), "nosniff");
});

test("a bodyless 302 survives the rebuild", () => {
  // startGithubFlow and handleCallback both return 302 with a null body, and a
  // Response constructed with a body on a 3xx would throw.
  const original = new Response(null, { status: 302, headers: { Location: "https://github.com/login/oauth/authorize" } });
  const out = withSecurityHeaders(original);
  assert.equal(out.status, 302);
  assert.equal(out.headers.get("Location"), "https://github.com/login/oauth/authorize");
  assert.equal(out.headers.get("Strict-Transport-Security"), HSTS);
});

test("HSTS does not claim preload", () => {
  // preload is a submission to a browser-vendor list and is effectively
  // irreversible. It is not something a header sweep should commit to.
  assert.doesNotMatch(HSTS, /preload/);
  assert.match(HSTS, /max-age=31536000/);
});
