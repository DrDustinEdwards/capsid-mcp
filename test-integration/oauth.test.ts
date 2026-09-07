import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// THE OAUTH SURFACE, WITH A REAL KV UNDER IT.
//
// This is the part of the Worker that has actually broken in production. The
// 2026-08-09 incident was a consent dialog that stopped rendering, undetected for
// 26 days, and the cause was four hops down a CSP chain nothing exercised. The
// provider itself is @cloudflare/workers-oauth-provider, a library this repo does
// not own, wired into src/index.ts; before this file nothing ran that wiring at
// all, and every unit test stopped at the handlers on either side of it.
//
// What is asserted here is what a browser and a client actually depend on: the
// discovery documents exist and describe this server, /register writes a real
// client record to a real KV, the consent dialog renders with the headers that
// broke, and the state cookie is scoped so a stolen one is not reusable.

describe("discovery", () => {
  it("serves protected-resource and authorization-server metadata", async () => {
    const resource = await SELF.fetch("https://capsid.test/.well-known/oauth-protected-resource");
    expect(resource.status).toBe(200);
    const resourceDoc = (await resource.json()) as { resource?: string; authorization_servers?: string[] };
    // THE AUDIENCE IS PINNED TO THE DEPLOYED ORIGIN, not to the request's. That is
    // the RFC 8707 fix both audits recorded as closed, and it is exactly why this
    // does not say capsid.test: a token minted for this server must not be
    // presentable at whatever host happened to ask for the metadata.
    expect(resourceDoc.resource).toBe("https://capsid.dustin-edwards.workers.dev/mcp");

    const server = await SELF.fetch("https://capsid.test/.well-known/oauth-authorization-server");
    expect(server.status).toBe(200);
    const serverDoc = (await server.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
      code_challenge_methods_supported?: string[];
    };
    expect(serverDoc.authorization_endpoint).toContain("/authorize");
    expect(serverDoc.token_endpoint).toContain("/token");
    // PKCE is the provider default and the audits recorded it as a positive
    // finding. A default is not a decision until something asserts it.
    expect(serverDoc.code_challenge_methods_supported).toContain("S256");
  });
});

describe("dynamic client registration", () => {
  it("registers a client and writes a real record to OAUTH_KV", async () => {
    const response = await SELF.fetch("https://capsid.test/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "integration-client",
        redirect_uris: ["https://client.example.com/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(response.status).toBe(201);
    const client = (await response.json()) as { client_id?: string; redirect_uris?: string[] };
    expect(typeof client.client_id).toBe("string");
    expect(client.redirect_uris).toEqual(["https://client.example.com/callback"]);

    // The record is in KV, under the provider's own prefix. This is the half the
    // 2026-08-17 vanished-client anomaly was about, and the live gate's canary
    // exists because nothing else could see it.
    const keys = await env.OAUTH_KV.list({ prefix: "client:" });
    expect(keys.keys.length).toBeGreaterThan(0);
    expect(keys.keys.some((k: { name: string }) => k.name.includes(String(client.client_id)))).toBe(true);
  });

  it("refuses a registration with no redirect_uri", async () => {
    const response = await SELF.fetch("https://capsid.test/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "no-redirect" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("authorize", () => {
  async function registerClient(): Promise<string> {
    const response = await SELF.fetch("https://capsid.test/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "authorize-client",
        redirect_uris: ["https://client.example.com/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = (await response.json()) as { client_id: string };
    return client.client_id;
  }

  it("PLANT: the consent dialog renders, with the headers whose absence caused the 26-day outage", async () => {
    const clientId = await registerClient();
    const url = new URL("https://capsid.test/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/callback");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "integration-state");

    const response = await SELF.fetch(url.toString());
    expect(response.status).toBe(200);
    const html = await response.text();
    // The dialog itself. On 2026-08-09 this rendered blank because its own inline
    // style and form were blocked by a policy set four hops away.
    expect(html).toContain('action="/authorize"');
    expect(html).toContain("method=\"post\"");

    // The enforced CSP is set by the dialog rather than by src/headers.ts,
    // because that policy was ruled on separately. If it stops allowing what the
    // page itself needs, this test is where that shows.
    const csp = response.headers.get("content-security-policy");
    expect(csp, "the consent dialog must carry its own enforced CSP").toBeTruthy();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBeTruthy();
  });

  it("refuses an authorize with a redirect_uri the client never registered", async () => {
    const clientId = await registerClient();
    const url = new URL("https://capsid.test/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://attacker.example.com/collect");
    url.searchParams.set("response_type", "code");
    const response = await SELF.fetch(url.toString());
    // Whatever the shape of the refusal, it must not be a 200 consent page for an
    // unregistered destination, and it must not redirect there.
    expect(response.status).not.toBe(200);
    expect(response.headers.get("location") ?? "").not.toContain("attacker.example.com");
  });
});

describe("callback", () => {
  it("PLANT: a callback with no state cookie is refused rather than followed", async () => {
    // The state cookie is sha256(state) with Path=/callback, so a code arriving
    // without the browser that started the flow has nothing to match against.
    const response = await SELF.fetch("https://capsid.test/callback?code=abc&state=whatever", { redirect: "manual" });
    expect(response.status).not.toBe(302);
    expect(await response.text()).toMatch(/state|expired|session/i);
  });
});

describe("the token endpoint", () => {
  it("refuses an authorization_code grant that was never issued", async () => {
    const response = await SELF.fetch("https://capsid.test/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "a-code-that-was-never-issued",
        redirect_uri: "https://client.example.com/callback",
        client_id: "nobody",
        code_verifier: "x".repeat(43),
      }).toString(),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.text();
    expect(body).toMatch(/invalid|grant|client/i);
  });
});
