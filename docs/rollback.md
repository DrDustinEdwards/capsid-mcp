# Rollback

Restore is about data. Rollback is about code: a deploy shipped a bad Worker and the fix is to serve the previous version now.

```
npx wrangler deployments list
npx wrangler rollback [<version-id>]
```

With no id it reverts to the immediately previous deployment. Pass a version id to go further back. It swaps the Worker script and that version's bindings and vars only. It does not touch D1, R2 or KV data, and it does not change `master`: the next push redeploys `HEAD` through CI and supersedes the rollback. Afterwards `/health` reports the rolled-back sha, so the scheduled live gate (which asserts `/health` sha equals master head) goes red until the fix ships. That red is correct. Production is behind master on purpose.
