// ONE-DIRECTIONAL STALENESS: prose that records a count.
//
// "22 tools", "6 of 6 gates", "all seven headers". Every one of those was true
// when written and every one rots silently, because nothing connects the sentence
// to the artifact it describes. The tool surface moved 16 to 19 to 22 across three
// sessions while the prose stayed put.
//
// This module holds the authoritative values and a scan that FLAGS prose
// disagreeing with them. It never rewrites anything: auto-correcting canon on a
// program's own judgement would be worse than the drift, and some numbers are
// deliberately historical.
//
// THE VALUES HERE ARE A CACHE, NOT THE SOURCE OF TRUTH. test/counts.test.ts
// derives each one from the actual artifact (the registrations in server.ts, the
// record() calls in verify-live.mjs, the header sets in headers.ts) and fails when
// the two disagree. Why each number is what it is, and which ruling moved it, is
// in capsid/decisions.md and capsid/core.md.
//
// KEYED BY NAMESPACE, and that is load-bearing. These numbers describe CAPSID's
// artifacts and nothing else. There was one global object until 2026-08-14 and the
// scan ran over every namespace, so another project's 24-gate suite was compared
// against capsid's 9 live gates: 16 claims flagged portfolio-wide and 14 of them
// were that. A lint that is wrong 14 times out of 16 is a lint nobody reads.
//
// A namespace with no entry gets NO count claims, which is correct rather than a
// gap: another project's counts are guarded by that project's own gates, against
// its own artifacts, and this module cannot see them.
export interface AuthoritativeCounts {
  tools: number;
  liveGates: number;
  htmlEnforcedHeaders: number;
  htmlReportOnlyHeaders: number;
}

export const AUTHORITATIVE: Record<string, AuthoritativeCounts> = {
  capsid: {
    tools: 30,
    liveGates: 10,
    htmlEnforcedHeaders: 6,
    htmlReportOnlyHeaders: 1,
  },
};

// Object.hasOwn, not `?? null`. AUTHORITATIVE carries Object.prototype, so a bare
// lookup of "constructor" returned the Object FUNCTION, which is not nullish: the
// guard never fired and the caller got a
// value whose .tools is undefined: garbage claims instead of "this namespace has
// no authoritative counts". Found 2026-09-05 by the capsid holdout suite before
// the improve loop had run once.
export function authoritativeFor(namespace: string): AuthoritativeCounts | null {
  return Object.hasOwn(AUTHORITATIVE, namespace) ? AUTHORITATIVE[namespace] : null;
}

// A four-digit year is never a count. `tool surface[^.\n]*?\b(\d+)\b` matched the 2026
// in "the 2026-07-28 migration" and reported it as a claim that capsid has 2026 tools.
const YEAR = /^(?:19|20)\d{2}$/;

// Episodics are EXEMPT, deliberately. A session doc saying "6 of 6 gates passed"
// is an accurate record of a run that happened, not a stale claim, and flagging
// it would bury the real findings in noise. Only documents that make STANDING
// claims are linted.
//
// `decision` IS EXEMPT, ruled 2026-08-15, and this retires a whole family of false
// positives rather than patching one more. An append-only ruling log is HISTORY BY
// CONSTRUCTION: every entry is dated, every entry records what was true when it was
// written, and none of them asserts current state. Three separate patterns tried to
// carve the exemption finer and each one revealed another shape behind it:
//
//   1. "check only the latest claim per noun" left the latest dated entry flagged;
//   2. exempting transitions ("19 to 22") unmasked a quoted past state behind it
//      ("core.md said 19 tools when server.ts registers 22"), which had been hidden
//      by rule 1 rather than handled by it;
//   3. and there is no reason to believe a fourth shape does not exist.
//
// The lint's jurisdiction is documents that assert what is true NOW: core, concept,
// reference and their siblings. A ruling log is not one of those, and linting it was a
// category error that produced only noise.
const LINTED_TYPES = new Set(["core", "concept", "semantic", "procedural", "spec", "reference", "protocol"]);

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

    const flag = (noun: string, match: RegExpExecArray, states: string, auth: string, note?: string) => {
      if (states === auth) return;
      claims.push({
        path: doc.path,
        type,
        noun,
        quote: quoteAround(body, match.index, match[0].length),
        states,
        authoritative: auth,
        ...(note ? { note } : {}),
      });
    };

    // Tool-count mentions, CLASSIFIED before they are compared: a bare number next
    // to the word "tools" is not automatically a claim about the surface size, and
    // treating it as one produced both surviving false positives of 2026-08-14.
    // Three passes in order, each consuming what it matched so a later pass cannot
    // re-read the same numbers as something else.
    const consumed: Array<[number, number]> = [];
    const isConsumed = (start: number) => consumed.some(([a, b]) => start >= a && start < b);
    const consume = (m: RegExpExecArray) => consumed.push([m.index, m.index + m[0].length]);

    // PASS 1, "N of M tools". M is the total; N is a SUBSET and says nothing about
    // the surface size. If N exceeds M the sentence contradicts itself, which is
    // checkable without knowing the authoritative figure at all.
    for (const re of [/(\d+)\s*(?:of|\/)\s*(\d+)\s+tools\b/gi, /tools?\s*\((\d+)\s*(?:of|\/)\s*(\d+)\)/gi]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        consume(m);
        const [, subset, total] = m;
        if (Number(subset) > Number(total)) {
          flag("tools", m, `${subset} of ${total}`, `a subset cannot exceed its total`, "internal contradiction: the subset is larger than the total it is drawn from");
        }
        if (!YEAR.test(total)) flag("tools", m, total, String(authoritative.tools));
      }
    }

    // PASS 2, "N to M tools". A transition says the count BECAME M, so N is the
    // pre-state. Flagging N reported "the surface is 19" against a sentence saying
    // it stopped being 19.
    for (const re of [/(\d+)\s+to\s+(\d+)\s+tools\b/gi, /tool surface[^.\n]*?\b(\d+)\s+to\s+(\d+)\b/gi]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        consume(m);
        const resulting = m[2];
        if (!YEAR.test(resulting)) flag("tools", m, resulting, String(authoritative.tools));
      }
    }

    // PASS 3, a plain "N tools", unless SUBSET-QUALIFIED. "The other 12 tools are
    // read-open" is true about a subset and was flagged as a stale total.
    const SUBSET_PREFIX = /\b(?:other|others|remaining|rest|read-open|read open|gated|write-gated|ungated|only|another|of those|of these|first|last)\b[^.\n]{0,12}$/i;
    for (const re of [/(\d+)\s+tools\b/gi, /tool surface[^.\n]*?\b(\d+)\b/gi]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        if (isConsumed(m.index)) continue;
        if (YEAR.test(m[1])) continue;
        const numberAt = m.index + m[0].indexOf(m[1]);
        if (SUBSET_PREFIX.test(body.slice(Math.max(0, numberAt - 40), numberAt))) continue;
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

    // The header count is no longer a single number, so any phrasing implying one
    // is stale by construction. SCOPED TO HEADER CONTEXT, and that is not
    // fussiness: measured across the live corpus, "all seven" appears in 25
    // documents and almost none are about headers.
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

  }

  return claims;
}
