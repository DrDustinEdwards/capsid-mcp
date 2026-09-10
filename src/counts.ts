// Authoritative counts for lint. Values are a cache; test/counts.test.ts derives
// each one from the artifact. A namespace with no entry is not scanned.
export interface AuthoritativeCounts {
  tools: number;
  liveGates: number;
  htmlEnforcedHeaders: number;
  htmlReportOnlyHeaders: number;
}

export const AUTHORITATIVE: Record<string, AuthoritativeCounts> = {
  capsid: {
    tools: 30,
    liveGates: 11,
    htmlEnforcedHeaders: 6,
    htmlReportOnlyHeaders: 1,
  },
};

// Object.hasOwn, not `?? null`. AUTHORITATIVE carries Object.prototype, so a bare
// lookup of "constructor" returned the Object function.
export function authoritativeFor(namespace: string): AuthoritativeCounts | null {
  return Object.hasOwn(AUTHORITATIVE, namespace) ? AUTHORITATIVE[namespace] : null;
}

// A four-digit year is never a count.
const YEAR = /^(?:19|20)\d{2}$/;

// Standing-claim types only. Episodics and decisions are history.
const LINTED_TYPES = new Set(["core", "concept", "semantic", "procedural", "spec", "reference", "protocol"]);

// The numbered decision volumes are history too. The exemption is by PATH as well
// as by type, because the type is the part a hand write gets wrong. The 2026-09-09
// split moved everything before 2026-08-10 into decisions-vol-1..3; each volume
// quotes tool and gate counts as they stood on the day of the ruling, so a volume
// mistyped as `reference` would report every historical number as stale.
const DECISION_VOLUME = /^decisions-vol-\d+\.md$/;

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
    if (DECISION_VOLUME.test(doc.path)) continue;

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

    // Three passes, each consuming what it matched so a later pass cannot re-read
    // the same numbers as something else.
    const consumed: Array<[number, number]> = [];
    const isConsumed = (start: number) => consumed.some(([a, b]) => start >= a && start < b);
    const consume = (m: RegExpExecArray) => consumed.push([m.index, m.index + m[0].length]);

    // "N of M tools": M is the total; N is a subset.
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

    // "N to M tools": the count became M.
    for (const re of [/(\d+)\s+to\s+(\d+)\s+tools\b/gi, /tool surface[^.\n]*?\b(\d+)\s+to\s+(\d+)\b/gi]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        consume(m);
        const resulting = m[2];
        if (!YEAR.test(resulting)) flag("tools", m, resulting, String(authoritative.tools));
      }
    }

    // Plain "N tools", unless subset-qualified.
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

    // "N of M gates": M is the claim about the artifact.
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

    // "all seven" is only a header claim in header context.
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
