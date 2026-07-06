import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { defaultHandler } from "./github-handler";
import { buildServer, isAdminUser, type Env, type Props } from "./server";

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: Props }).props;
    if (!props || !isAdminUser(env, props)) {
      return new Response("forbidden: capsid is a single-user server and this grant does not belong to its administrator", {
        status: 403,
      });
    }
    return createMcpHandler(buildServer(env, true), { route: "/mcp" })(request, env, ctx);
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
