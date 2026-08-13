// Lets `node --test` import src/server.ts, which imports its siblings without a
// file extension ("./github", "./auth").
//
// Node's ESM resolver requires the extension; the Worker bundler does not, and every
// module in src/ is written for the bundler. Most existing tests never hit this
// because they import a leaf module whose only relative import is `import type`,
// which is erased before Node ever resolves it. test/write-invariants.test.ts is the
// first to import server.ts, which has seven real runtime imports.
//
// The alternative was appending .ts to every relative specifier in src/. That is the
// modern TypeScript style and it would work, but it changes what goes into the
// production bundle to make a test runnable, and this session's job is the audit
// findings rather than an import restyle. This hook cannot affect the deployed
// Worker: it exists only in the test process.
//
// Registered by the test script via --import. Delete it the day src/ carries
// explicit extensions.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Fall through to the normal failure, so a genuinely missing module still
        // reports itself rather than reporting a missing .ts file.
      }
    }
    return nextResolve(specifier, context);
  },
});
