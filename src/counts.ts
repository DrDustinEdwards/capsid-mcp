// Batch-two item 10: one-directional staleness.
//
// Capsid records counts in prose. "22 tools", "6 of 6 gates", "all seven
// headers". Every one of those was true when written and every one of them rots
// silently, because nothing connects the sentence to the artifact it describes.
// The tool surface moved 16 to 19 to 22 across three sessions; the live gate
// count moved 6 to 8 in one; the header count is now not even a single number.
//
// This module holds the authoritative values and a scan that FLAGS prose
// disagreeing with them. It never rewrites anything. Auto-correcting prose would
// mean a program editing canon on its own judgement, and the numbers are
// sometimes deliberately historical.
//
// The values here are not the source of truth, they are a cache of it, and
// test/counts.test.ts is what keeps them honest: it derives each one from the
// actual artifact (the registrations in server.ts, the record() calls in
// verify-live.mjs, the header sets in headers.ts) and fails when they disagree.
// That is the "derive the expected list from the source of truth" rule from
// capsid/conventions.md, applied to numbers instead of table names.

// tools moved 22 to 24 on 2026-08-13: history and restore. That is a deliberate
// exception to the repo's own "the tool surface is deliberately small and should
// stay that way" rule, ruled by Dustin in the audit response, because every
// overwrite and delete had been snapshotting to document_versions since day one and
// nothing could read a snapshot back without raw SQL.
//
// liveGates moved 8 to 9 the same day: /health gained a D1 and FTS probe, so a
// deploy that unbinds the store now goes red.
export const AUTHORITATIVE = {
  tools: 24,
  liveGates: 9,
  htmlEnforcedHeaders: 6,
  htmlReportOnlyHeaders: 1,
};

// Episodics are EXEMPT, deliberately. A session doc saying "6 of 6 gates passed"
// is an accurate record of a run that happened, not a stale claim, and flagging
// it would bury the real findings in noise. Only documents that make STANDING
// claims are linted.
const LINTED_TYPES = new Set(["core", "concept", "semantic", "procedural", "decision", "spec", "reference", "protocol"]);

export interface CountClaim {
  path: string;
  type: string;
  noun: string;
  quote: string;
  states: string;
  authoritative: string;
  note?: string;
}

interface ScannableDoc {
  path: string;
  type: string | null;
  body: string | null;
}

function quoteAround(body: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(body.length, index + length + 40);
  return `${start > 0 ? "..." : ""}${body.slice(start, end).replace(/\s+/g, " ")}${end < body.length ? "..." : ""}`;
}

export function scanCountClaims(docs: ScannableDoc[]): CountClaim[] {
  const claims: CountClaim[] = [];

  for (const doc of docs) {
    const body = doc.body ?? "";
    const type = doc.type ?? "note";
    if (!LINTED_TYPES.has(type)) continue;
    if (doc.path.startsWith("archive/")) continue;

    const flag = (noun: string, match: RegExpExecArray, states: string, authoritative: string, note?: string) => {
      if (states === authoritative) return;
      claims.push({
        path: doc.path,
        type,
        noun,
        quote: quoteAround(body, match.index, match[0].length),
        states,
        authoritative,
        ...(note ? { note } : {}),
      });
    };

    // "22 tools", "tool surface at 22", "surface is 22"
    for (const re of [/(\d+)\s+tools\b/gi, /tool surface[^.\n]*?\b(\d+)\b/gi]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        flag("tools", m, m[1], String(AUTHORITATIVE.tools));
      }
    }

    // "8 gates", "6 of 6 gates". For the "N of M" form the TOTAL is the claim
    // about the artifact; the numerator is how many passed on some run.
    let m: RegExpExecArray | null;
    const ofForm = /(\d+)\s*(?:of|\/)\s*(\d+)\s+gates?\b/gi;
    while ((m = ofForm.exec(body)) !== null) {
      flag("live gates", m, m[2], String(AUTHORITATIVE.liveGates), "the total, not the number that passed");
    }
    const plainForm = /\b(\d+)\s+(?:live\s+)?gates\b(?!\s*(?:passed|failed))/gi;
    while ((m = plainForm.exec(body)) !== null) {
      flag("live gates", m, m[1], String(AUTHORITATIVE.liveGates));
    }

    // The header count is no longer a single number, so any phrasing that
    // implies one is stale by construction. "all seven" is called out by name
    // because it is the exact phrase batch-two item 8 was written with, and it
    // is now wrong: six are enforced and the seventh is on trial.
    //
    // SCOPED TO HEADER CONTEXT, and this is not fussiness. Measured across the
    // live corpus 2026-08-12: "all seven" appears in 25 documents and almost
    // none are about headers. Seven ROWS files, seven manifest fields, seven
    // migrations, seven width probes. An unscoped match would have flagged all
    // of them, and a lint that cries wolf 24 times out of 25 is a lint nobody
    // reads. Only a match whose neighbourhood also talks about headers counts.
    const HEADER_CONTEXT = /header|security-policy|\bCSP\b|\bHSTS\b|nosniff|Referrer-Policy|X-Frame-Options|Permissions-Policy|COOP/i;
    const sevenForm = /all seven\b[^.\n]*/gi;
    while ((m = sevenForm.exec(body)) !== null) {
      const neighbourhood = body.slice(Math.max(0, m.index - 200), Math.min(body.length, m.index + m[0].length + 200));
      if (!HEADER_CONTEXT.test(neighbourhood)) continue;
      claims.push({
        path: doc.path,
        type,
        noun: "security headers",
        quote: quoteAround(body, m.index, m[0].length),
        states: "all seven",
        authoritative: `${AUTHORITATIVE.htmlEnforcedHeaders} enforced plus ${AUTHORITATIVE.htmlReportOnlyHeaders} Report-Only`,
        note: "COOP ships Report-Only pending a demonstrated case and a ruling, so 'all seven enforced' overstates what is live",
      });
    }
  }

  return claims;
}
