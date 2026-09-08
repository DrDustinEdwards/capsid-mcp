// THE TRUTH REPORT. One number, and the six counts it is made of.
//
// WHAT PROBLEM THIS IS FOR. capsid/conventions.md states the mechanism plainly:
// "CAPSID CANNOT BE GATED. Every gate in every repo verifies DISK. So a number
// that lives only here can be wrong forever and nothing notices." The lint loop
// already had pieces of an answer, scattered across a gather packet nobody reads
// end to end: count claims, dangling edges, an unconsolidated tally. What it had
// no way to say was whether the store is getting more or less true, because
// nothing was written down and compared.
//
// So `lint` gains a third mode, and it produces a DOCUMENT. The trend is the
// point. A number in a tool response is a number one session saw; a number in
// `<namespace>/reports/lint-<date>.md` is a series, and a series is the only form
// in which "the canon is drifting" is visible before somebody trips over it.
//
// WHAT INTEGRITY IS, and it is a ratio rather than a grade. Every check below
// counts SUBJECTS (documents, edges, claims, paths) and how many of them are in
// good standing. Integrity is good standing over subjects, across all six checks,
// weighted by nothing. That is deliberately crude: a weighted score invites
// arguing with the weights instead of fixing the finding, and this number exists
// to be looked at, not optimised.
//
// WHAT IT IS NOT. It does not judge whether a decision is CORRECT, whether a
// concept doc is well written, or whether a ruling still applies. Those need a
// reader. This counts the things a program can count without an opinion.

export interface TruthFinding {
  // What was checked, and what did not pass.
  check: string;
  subject: string;
  detail: string;
}

export interface TruthCheck {
  check: string;
  subjects: number;
  ok: number;
  findings: TruthFinding[];
}

export interface TruthReport {
  namespace: string;
  generated: string;
  documents: {
    total: number;
    by_type: Record<string, number>;
    unconsolidated: number;
    archived: number;
  };
  checks: TruthCheck[];
  // Good standing over subjects, across every check that had a subject to judge.
  // Null when nothing was checkable, which is not the same as 100 percent.
  integrity: number | null;
  findings: TruthFinding[];
}

export interface ReportDoc {
  path: string;
  type: string | null;
  status: string | null;
  title: string | null;
  body: string | null;
  updated_at: string;
}

export interface ReportEdge {
  from_ns: string;
  from_path: string;
  type: string;
  to_ns: string;
  to_path: string;
  source_missing?: number;
  target_missing?: number;
}

// The shape src/counts.ts already returns. Mirrored rather than imported so this
// module stays a pure function over plain data, which is what makes it testable
// without a database.
export interface ReportCountClaim {
  path: string;
  noun: string;
  states: string;
  authoritative: string;
  quote: string;
}

export interface TruthInput {
  namespace: string;
  now: Date;
  docs: ReportDoc[];
  edges: ReportEdge[];
  danglingEdges: ReportEdge[];
  countClaims: ReportCountClaim[];
  // Repo paths that exist on the default branch. Undefined when the repo could
  // not be read, which makes the drift check UNRUN rather than clean: a check
  // that reports zero findings because it could not look is the exact failure
  // capsid/conventions.md names ("an assertion that can pass by reading nothing").
  repoPaths?: Set<string>;
}

// A decision older than this, still `published`, is stale enough to be worth
// re-reading. Not a defect: a ruling can be right for years. It is a prompt.
export const STALE_DECISION_DAYS = 180;

// Matches a repo path in prose: at least one slash, a file extension, and no
// spaces. Deliberately narrow. `src/server.ts` and `.github/workflows/ci.yml`
// match; `capsid/conventions.md` matches too and is excluded below, because a
// Capsid document path is not a repo path and confusing the two would report the
// whole canon as drift.
const REPO_PATH = /\b((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,5})\b/g;

// Namespace prefixes that mean "a Capsid document", not "a file in the repo".
// A path starting with one of these is a store address and is skipped.
const NAMESPACE_PREFIXES = ["capsid/", "germomics/", "foxing/", "foxhound/", "dustinedwards/", "julieedwards/", "txasm/", "bsw/", "recova/"];

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

function parseStamp(value: string): Date | null {
  // D1 writes `YYYY-MM-DD HH:MM:SS` with no zone. Read as UTC rather than local,
  // or the same document is stale on one machine and fresh on another.
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

// A document is "standing" if it is part of the canon rather than raw material.
// archive/ is consumed history and is not held to any of this.
const isArchived = (doc: ReportDoc) => doc.path.startsWith("archive/");

export function buildTruthReport(input: TruthInput): TruthReport {
  const { namespace, now, docs } = input;
  const standing = docs.filter((d) => !isArchived(d));
  const archived = docs.length - standing.length;

  const byType: Record<string, number> = {};
  for (const doc of docs) {
    const type = doc.type ?? "(untyped)";
    byType[type] = (byType[type] ?? 0) + 1;
  }

  const checks: TruthCheck[] = [];

  // 1. CONTRADICTIONS: a fact stated differently in two places. The store has one
  //    mechanical form of this and it is the count claim: prose asserting a number
  //    that the artifact disagrees with. src/counts.ts already finds them; this is
  //    what turns "the packet listed some claims" into "N of M claims are wrong".
  checks.push({
    check: "contradictions",
    subjects: input.countClaims.length,
    ok: 0,
    findings: input.countClaims.map((claim) => ({
      check: "contradictions",
      subject: `${namespace}/${claim.path}`,
      detail: `states ${claim.states} ${claim.noun}; the artifact says ${claim.authoritative}. In: ${claim.quote}`,
    })),
  });
  // Every claim the scanner returns is a MISMATCH, so subjects is the mismatch
  // count and there is no clean population to divide by. Counting the whole
  // standing corpus as the population instead: a claim is a property of a
  // document, and the question is what fraction of documents carry a wrong one.
  const contradicting = new Set(input.countClaims.map((c) => c.path));
  checks[0] = {
    check: "contradictions",
    subjects: standing.length,
    ok: standing.length - [...contradicting].filter((p) => standing.some((d) => d.path === p)).length,
    findings: checks[0].findings,
  };

  // 2. STALE DECISIONS. A decision document nobody has touched in half a year,
  //    still published. capsid/conventions.md: "a state claim older than the last
  //    session close is re-verified against live code before it is acted on". A
  //    reader cannot apply that rule to a document whose age they cannot see.
  const decisions = standing.filter((d) => d.type === "decision" && (d.status ?? "published") === "published");
  const staleDecisions = decisions.filter((d) => {
    const stamp = parseStamp(d.updated_at);
    return stamp !== null && daysBetween(now, stamp) > STALE_DECISION_DAYS;
  });
  checks.push({
    check: "stale_decisions",
    subjects: decisions.length,
    ok: decisions.length - staleDecisions.length,
    findings: staleDecisions.map((d) => ({
      check: "stale_decisions",
      subject: `${namespace}/${d.path}`,
      detail: `last written ${d.updated_at}, over ${STALE_DECISION_DAYS} days ago, and still published`,
    })),
  });

  // 3. UNBOUND SPECS. A spec document with no typed edge in either direction is a
  //    document nothing points at and that points at nothing: it was written, and
  //    then the work either happened somewhere else or did not happen. Either way
  //    a reader has no way to find out from the store.
  const specs = standing.filter((d) => d.type === "spec" || d.type === "protocol" || d.type === "procedural");
  const bound = new Set<string>();
  for (const edge of input.edges) {
    if (edge.from_ns === namespace) bound.add(edge.from_path);
    if (edge.to_ns === namespace) bound.add(edge.to_path);
  }
  const unbound = specs.filter((d) => !bound.has(d.path));
  checks.push({
    check: "unbound_specs",
    subjects: specs.length,
    ok: specs.length - unbound.length,
    findings: unbound.map((d) => ({
      check: "unbound_specs",
      subject: `${namespace}/${d.path}`,
      detail: `type '${d.type}' with no typed edge in either direction; nothing in the store points at it and it points at nothing`,
    })),
  });

  // 4. BROKEN LINKS. Already computed by gather; counted here against the whole
  //    edge population so the number means something.
  const namespaceEdges = input.edges.filter((e) => e.from_ns === namespace || e.to_ns === namespace);
  checks.push({
    check: "broken_links",
    subjects: namespaceEdges.length,
    ok: namespaceEdges.length - input.danglingEdges.length,
    findings: input.danglingEdges.map((e) => ({
      check: "broken_links",
      subject: `${e.from_ns}/${e.from_path} -[${e.type}]-> ${e.to_ns}/${e.to_path}`,
      detail: e.source_missing ? "the source document no longer exists" : "the target document no longer exists",
    })),
  });

  // 5. DOC-VS-CODE DRIFT. A repo path named in canon that is not in the repo any
  //    more. This is the check that answers the mechanism the conventions state:
  //    the repo is gated and the store is not, so the store is where a path rots.
  //
  //    UNRUN IS NOT CLEAN. When the repo could not be read the check reports zero
  //    subjects and is excluded from integrity, rather than reporting zero
  //    findings, which would read as perfect.
  if (input.repoPaths) {
    const cited = new Map<string, Set<string>>();
    for (const doc of standing) {
      for (const match of (doc.body ?? "").matchAll(REPO_PATH)) {
        const path = match[1];
        if (NAMESPACE_PREFIXES.some((p) => path.startsWith(p))) continue;
        if (!cited.has(path)) cited.set(path, new Set());
        cited.get(path)!.add(doc.path);
      }
    }
    const missing = [...cited.entries()].filter(([path]) => !input.repoPaths!.has(path));
    checks.push({
      check: "doc_vs_code_drift",
      subjects: cited.size,
      ok: cited.size - missing.length,
      findings: missing.map(([path, docPaths]) => ({
        check: "doc_vs_code_drift",
        subject: path,
        detail: `named in ${[...docPaths].sort().join(", ")} and absent from the repo`,
      })),
    });
  } else {
    checks.push({
      check: "doc_vs_code_drift",
      subjects: 0,
      ok: 0,
      findings: [
        {
          check: "doc_vs_code_drift",
          subject: namespace,
          detail: "NOT RUN: the repo tree could not be read, so this check is excluded from integrity rather than counted as clean",
        },
      ],
    });
  }

  // 6. UNCONSOLIDATED. Not a defect, a backlog: conventions puts the lint cadence
  //    at roughly five. Counted so the trend is visible beside the rest.
  const unconsolidated = standing.filter((d) => d.type === "episodic" || d.type === "source");
  checks.push({
    check: "unconsolidated",
    subjects: standing.length,
    ok: standing.length - unconsolidated.length,
    findings:
      unconsolidated.length > 5
        ? [
            {
              check: "unconsolidated",
              subject: namespace,
              detail: `${unconsolidated.length} unconsolidated documents, over the lint cadence of ~5 in capsid/conventions.md`,
            },
          ]
        : [],
  });

  const judged = checks.filter((c) => c.subjects > 0);
  const subjects = judged.reduce((sum, c) => sum + c.subjects, 0);
  const good = judged.reduce((sum, c) => sum + c.ok, 0);
  const integrity = subjects > 0 ? Math.round((good / subjects) * 1000) / 10 : null;

  return {
    namespace,
    generated: input.now.toISOString(),
    documents: {
      total: docs.length,
      by_type: byType,
      unconsolidated: unconsolidated.length,
      archived,
    },
    checks,
    integrity,
    findings: checks.flatMap((c) => c.findings),
  };
}

// The stored document. The integrity line is FIRST and in a fixed shape, because
// `improve_status` parses it back out: a number a program has to find in prose is
// a number that will one day be in different prose.
export const INTEGRITY_LINE = /^integrity:\s*([0-9]+(?:\.[0-9]+)?)%\s*$/m;

export function renderTruthReport(report: TruthReport): string {
  const lines: string[] = [];
  lines.push(`# Truth report - ${report.namespace} - ${report.generated.slice(0, 10)}`);
  lines.push("");
  lines.push(`integrity: ${report.integrity === null ? "0" : report.integrity}%`);
  lines.push("");
  lines.push(
    "One number and the checks it is made of. Integrity is subjects in good standing over subjects judged, across every check that had a subject to judge. " +
      "A check that could not run is excluded rather than counted as clean. Nothing here judges whether a ruling is CORRECT; it counts what a program can count without an opinion."
  );
  lines.push("");
  lines.push("## Documents");
  lines.push("");
  lines.push(`- total: ${report.documents.total}`);
  lines.push(`- archived: ${report.documents.archived}`);
  lines.push(`- unconsolidated: ${report.documents.unconsolidated}`);
  for (const [type, n] of Object.entries(report.documents.by_type).sort()) {
    lines.push(`- type ${type}: ${n}`);
  }
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push("| check | subjects | ok | findings |");
  lines.push("| --- | --- | --- | --- |");
  for (const check of report.checks) {
    lines.push(`| ${check.check} | ${check.subjects} | ${check.ok} | ${check.findings.length} |`);
  }
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("## Findings");
    lines.push("");
    lines.push("None.");
  } else {
    lines.push("## Findings");
    lines.push("");
    for (const check of report.checks) {
      if (check.findings.length === 0) continue;
      lines.push(`### ${check.check}`);
      lines.push("");
      for (const finding of check.findings) {
        lines.push(`- **${finding.subject}**: ${finding.detail}`);
      }
      lines.push("");
    }
  }
  lines.push("Generated by `lint` mode `report`. The trend is the point: compare this against the previous dated report in this directory.");
  lines.push("");
  return lines.join("\n");
}

// The stored path. One per namespace per day, so a second run the same day
// overwrites rather than accumulating: the series is daily, not per-invocation.
export function reportPath(date: Date): string {
  return `reports/lint-${date.toISOString().slice(0, 10)}.md`;
}

export const REPORTS_PREFIX = "reports/";

// Pull the integrity number back out of a stored report. Returns null on anything
// unexpected, which `improve_status` reports as "no report" rather than as zero.
export function integrityOf(body: string | null | undefined): number | null {
  if (!body) return null;
  const match = INTEGRITY_LINE.exec(body);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
