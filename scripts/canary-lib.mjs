// The canary CHECK, separated from the gate so it can be driven by a test, for the same
// reason scripts/reap-lib.mjs exists: verify-live.mjs is a program that runs on import.
//
// What the canary is and why it has no expiry: scripts/bindings.mjs, CANARY_CLIENT.
//
// IT READS KV DIRECTLY RATHER THAN ASKING THE WORKER. Driving /authorize with the canary
// id would be more end-to-end and a worse signal: a missing client and a KV outage are
// the same error page, so the gate could not say which it saw. The REST API answers with
// a STATUS, and the status IS the distinction.

/**
 * @returns {Promise<{ outcome: "present"|"missing"|"unreachable"|"corrupt"|"has-ttl", detail?: string, expiration?: number }>}
 */
export async function checkCanary({ fetchImpl, base, clientId, auth }) {
  const key = `client:${clientId}`;

  let resp = null;
  try {
    resp = await fetchImpl(`${base}/values/${encodeURIComponent(key)}`, { headers: auth });
  } catch (err) {
    // A thrown fetch is a network failure. It says nothing about the record, and calling
    // it "missing" would manufacture data loss out of a DNS blip.
    return { outcome: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }

  if (!resp.ok && resp.status !== 404) {
    return { outcome: "unreachable", detail: `status=${resp.status}` };
  }

  if (resp.status === 404) return { outcome: "missing" };

  // "A key exists at that name" is weaker than it looks: a truncated or foreign
  // value still reads 200.
  const body = await resp.text().catch(() => "");
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (parsed?.clientId !== clientId) {
    return { outcome: "corrupt", detail: body.slice(0, 120) };
  }

  // It must still be NON-EXPIRING. Re-minting the canary through /register would give it
  // the 90 day clientRegistrationTTL back, and a canary that can expire on its own has a
  // second legitimate reason to be absent.
  //
  // An unreadable key LIST is not treated as a TTL: absence of evidence about the expiry
  // is not evidence of one.
  let expiration;
  try {
    const listed = await fetchImpl(`${base}/keys?prefix=${encodeURIComponent(key)}`, { headers: auth });
    const data = await listed.json().catch(() => null);
    expiration = data?.result?.find((k) => k.name === key)?.expiration;
  } catch {
    expiration = undefined;
  }
  if (expiration) return { outcome: "has-ttl", expiration };

  return { outcome: "present" };
}

// outcome -> what the gate records. Kept beside the check so the two cannot drift.
export function canaryReport(result, clientId, namespaceName) {
  const key = `client:${clientId}`;
  switch (result.outcome) {
    case "present":
      return { passed: true, detail: `${key} present, non-expiring, clientId matches` };
    case "missing":
      return {
        passed: false,
        detail:
          `MISSING: ${key} is GONE from ${namespaceName}. This record has no expiry and the reaper never touches it, ` +
          `so this is the vanished-client-record anomaly of 2026-08-17 recurring. Every OAuth client in this keyspace is suspect; ` +
          `check whether live grants survived before re-minting.`,
      };
    case "unreachable":
      return {
        passed: false,
        detail: `UNREACHABLE: could not read ${key} (${result.detail}). This is a KV or credential failure and is NOT evidence the record is gone.`,
      };
    case "corrupt":
      return { passed: false, detail: `CORRUPT: ${key} reads 200 but does not carry clientId=${clientId}. Value starts: ${result.detail}` };
    case "has-ttl":
      return {
        passed: false,
        detail:
          `HAS A TTL: ${key} expires ${new Date(result.expiration * 1000).toISOString().slice(0, 10)}. ` +
          `The canary must not expire, or a normal expiry reads as data loss. Re-put the value with no expiration_ttl.`,
      };
    default:
      return { passed: false, detail: `unknown canary outcome ${JSON.stringify(result.outcome)}` };
  }
}
