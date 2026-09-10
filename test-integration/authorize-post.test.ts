import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// /authorize POST's BODY CAP, measured against the real runtime.
//
// The consent form POST was the last unbounded body read in this Worker: it
// called request.formData(), which buffers and PARSES the whole body before any
// check runs. It is reachable without credentials (the CSRF cookie is checked
// after the parse, and a caller can obtain one by fetching the form), so an
// oversized POST spent parse time and memory before the first refusal.
//
// SEPARATE FROM /csp-report ON PURPOSE. That endpoint's fix was the same primitive, but
// this one is the OAuth consent path, where a small, safe-looking change broke logins
// for 26 days in 2026-08. The behaviour that must not change is asserted here in the
// same file as the new bound: an ordinary form still reaches its CSRF check and is
// refused for the CSRF reason, not for a size reason.

const ORIGIN = "https://capsid.test";

async function postForm(body: string, headers: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

describe("/authorize POST bounds the body before parsing it", () => {
  it("refuses a body over the cap with 413", async () => {
    const body = `csrf=x&req=${"A".repeat(70_000)}`;
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(65_536);
    const resp = await postForm(body);
    expect(resp.status).toBe(413);
  });

  it("counts BYTES, not characters", async () => {
    // 30,000 three-byte characters is 90,000 bytes on the wire and 30,000 by
    // String#length. A cap applied after formData() would have measured the
    // decoded string; this one measures what arrived.
    const body = `csrf=x&req=${encodeURIComponent("あ".repeat(30_000))}`;
    const resp = await postForm(body);
    expect(resp.status).toBe(413);
  });

  it("an ordinary form still reaches the CSRF check, which is the behaviour that must not change", async () => {
    // 403 (csrf) rather than 413 (too large) or 500. This is the assertion that
    // would catch a bound applied so tightly, or so early, that it broke consent.
    const resp = await postForm("csrf=nonsense&req=nonsense");
    expect(resp.status).toBe(403);
    expect(await resp.text()).toMatch(/csrf/i);
  });

  it("a form missing its fields is still a 400, not a size refusal", async () => {
    const resp = await postForm("nothing=here");
    expect(resp.status).toBe(400);
  });

  it("an empty body is a 400", async () => {
    const resp = await postForm("");
    expect(resp.status).toBe(400);
  });
});
