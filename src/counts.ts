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
// KEYED BY NAMESPACE, and that is the whole point rather than a formality. These
// numbers are derived from CAPSID'S artifacts: registerTool calls in src/server.ts,
// record() labels in scripts/verify-live.mjs, the header sets in src/headers.ts. They
// describe capsid and nothing else.
//
// Until 2026-08-14 there was one global object and the scan ran over every namespace,
// so dustinedwards's own 24-gate suite was compared against capsid's 9 live gates and
// the operator wrapper's 5 tools against capsid's 24. Measured that day: 16 claims
// flagged portfolio-wide and 14 of them were this. A lint that is wrong 14 times out
// of 16 is a lint nobody reads, which is the same failure the "all seven" scoping fix
// addressed two days earlier.
//
// A namespace with no entry here gets NO count claims. That is correct rather than a
// gap: another project's counts are guarded by that project's own gates, against its
// own artifacts, and this module cannot see them.
export interface AuthoritativeCounts {
  tools: number;
  liveGates: number;
  htmlEnforcedHeaders: number;
  htmlReportOnlyHeaders: number;
}

export const AUTHORITATIVE: Record<string, AuthoritativeCounts> = {
  capsid: {
    tools: 24,
    liveGates: 9,
    htmlEnforcedHeaders: 6,
    htmlReportOnlyHeaders: 1,
  },
};

export function authoritativeFor(namespace: string): AuthoritativeCounts | null {
  return AUTHORITATIVE[namespace] ?? null;
}

// A four-digit year is never a count. `tool surface[^.\n]*?\b(\d+)\b` matched the 2026
// in "the 2026-07-28 migration" and reported it as a claim that capsid has 2026 tools.
const YEAR = /^(?:19|20)\d{2}$/;

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

export function scanCountClaims(docs: ScannableDoc[], namespace: string): CountClaim[] {
  const claims: CountClaim[] = [];
  const authoritative = authoritativeFor(namespace);
  // No authoritative numbers for this namespace means no claims. See AUTHORITATIVE.
  if (!authoritative) return claims;

  for (const doc of docs) {
    const body = doc.body ?? "";
    const type = doc.type ?? "note";
    if (!LINTED_TYPES.has(type)) continue;
    if (doc.path.startsWith("archive/")) continue;

    // AN APPEND-ONLY LOG RECORDS HISTORY, and history is not staleness.
    //
    // capsid/decisions.md says the tool surface went "16 to 19 to 22", which was true
    // when each was written and is the whole point of an append-only ruling log. The
    // scan flagged all three as stale claims that the surface is 16, 19 and 22.
    //
    // So for a `decision` document, only the LAST claim of each noun is checked: the
    // most recent statement is the one asserting current state, and everything above
    // it is the record of how it got there. Any other type states current fact
    // throughout, so every match is checked.
    const historyOnly = type === "decision";
    const pending = new Map<string, CountClaim[]>();

    const flag = (noun: string, match: RegExpExecArray, states: string, auth: string, note?: string) => {
      const claim: CountClaim = {
        path: doc.path,
        type,
        noun,
        quote: quoteAround(body, match.index, match[0].length),
        states,
        authoritative: auth,
        ...(note ? { note } : {}),
      };
      // Collected even when it agrees, because a later agreeing claim is what makes
      // an earlier disagreeing one history rather than an error.
      const list = pending.get(noun) ?? [];
      list.push(claim);
      pending.set(noun, list);
    };

    // "22 tools", "tool surface at 22", "surface is 22"
    for (const re of [/(\d+)\s+tools\b/gi, /tool surface[^.\n]*?\b(\d+)\b/gi]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        if (YEAR.test(m[1])) continue;
        flag("tools", m, m[1], String(authoritative.tools));
      }
    }

    // "8 gates", "6 of 6 gates". For the "N of M" form the TOTAL is the claim
    // about the artifact; the numerator is how many passed on some run.
    let m: RegExpExecArray | null;
    const ofForm = /(\d+)\s*(?:of|\/)\s*(\d+)\s+gates?\b/gi;
    while ((m = ofForm.exec(body)) !== null) {
      if (YEAR.test(m[2])) continue;
      flag("live gates", m, m[2], String(authoritative.liveGates), "the total, not the number that passed");
    }
    const plainForm = /\b(\d+)\s+(?:live\s+)?gates\b(?!\s*(?:passed|failed))/gi;
    while ((m = plainForm.exec(body)) !== null) {
      if (YEAR.test(m[1])) continue;
      flag("live gates", m, m[1], String(authoritative.liveGates));
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
      flag(
        "security headers",
        m,
        "all seven",
        `${authoritative.htmlEnforcedHeaders} enforced plus ${authoritative.htmlReportOnlyHeaders} Report-Only`,
        "COOP ships Report-Only pending a demonstrated case and a ruling, so 'all seven enforced' overstates what is live"
      );
    }

    // Resolve what was collected. For an append-only log only the newest claim per
    // noun is a statement about now; for everything else, every claim is.
    for (const list of pending.values()) {
      const checked = historyOnly ? list.slice(-1) : list;
      for (const claim of checked) {
        if (claim.states !== claim.authoritative) claims.push(claim);
      }
    }
  }

  return claims;
}
