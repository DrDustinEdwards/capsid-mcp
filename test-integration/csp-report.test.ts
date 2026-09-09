import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// /csp-report's BODY CAP, measured against the real runtime (residual 11).
//
// The endpoint used to call request.text() and then compare raw.length against
// 16384. Two problems, and only the second is visible from the outside:
//
//   1. request.text() buffers the ENTIRE body before its size can be checked, so
//      a public unauthenticated path with no body cap in front of it decided
//      whether to refuse a request only after it had accepted all of it.
//   2. raw.length counts UTF-16 CODE UNITS, not bytes. A body of 16,384 three-byte
//      characters is 49,152 bytes on the wire and 16,384 by that measure, so the
//      cap was three times looser than the number written next to it for exactly
//      the input someone probing this endpoint would send.
//
// readBoundedText, which the three signed endpoints already use, pulls from the
// stream and aborts on the byte that crosses the cap. This suite is the layer that
// can tell the two apart: it posts real bodies to the real handler in workerd.

const ORIGIN = "https://capsid.test";
const CAP = 16_384;

function report(padding: string) {
  return JSON.stringify({
    "csp-report": {
      "document-uri": `${ORIGIN}/probe`,
      "effective-directive": "integration-probe",
      "blocked-uri": "https://example.com/probe",
      note: padding,
    },
  });
}

async function postReport(body: string) {
  return SELF.fetch(`${ORIGIN}/csp-report`, {
    method: "POST",
    headers: { "Content-Type": "application/csp-report" },
    body,
  });
}

describe("/csp-report bounds the body in bytes, before buffering it", () => {
  it("accepts an ordinary report", async () => {
    const resp = await postReport(report("a real violation would say more than this"));
    expect(resp.status).toBe(204);
  });

  it("refuses a body over the cap", async () => {
    const body = report("x".repeat(CAP));
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(CAP);
    const resp = await postReport(body);
    expect(resp.status).toBe(413);
  });

  it("counts BYTES, not UTF-16 code units: a multi-byte body over the cap is refused", async () => {
    // Each of these is one code unit and THREE bytes. 8,000 of them is 24,000
    // bytes on the wire, comfortably over the cap, while String#length reads
    // 8,000 and the old check let it through and wrote it to R2.
    const padding = "あ".repeat(8_000);
    const body = report(padding);
    const bytes = new TextEncoder().encode(body).byteLength;
    expect(body.length).toBeLessThan(CAP);
    expect(bytes).toBeGreaterThan(CAP);
    const resp = await postReport(body);
    expect(resp.status).toBe(413);
  });

  it("still accepts a multi-byte body that is genuinely under the cap", async () => {
    // NOT VACUOUS: the byte cap must not refuse every non-ASCII report. A cap that
    // rejected all multi-byte input would pass the assertion above for the wrong
    // reason.
    const body = report("あ".repeat(200));
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(CAP);
    const resp = await postReport(body);
    expect(resp.status).toBe(204);
  });
});
