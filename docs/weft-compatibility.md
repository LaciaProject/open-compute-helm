# Weft compatibility verification

The `Weft compatibility` workflow verifies the pinned Weft candidate against the
released open-compute image installed by this Chart in Kind. Inputs live in
[the verification lock](../.github/weft-compatibility.lock.json).

This is a compatibility gate, not a Weft installation recipe. The job fails when
the report contains a blocker. Successful Helm CI alone does not establish Weft
application compatibility. No production Cloudflare account, model credential,
Access login or Docker Broker qualification is used by this workflow.

The open-compute source checkout is used to review provider constraints. The
runtime under test is the pinned published `0.4.0` image; it is not rebuilt from
that source checkout.

## Checks

- Build the unmodified pinned Weft checkout and its actual workspace image.
- Install this Helm Chart in Kubernetes and verify a real Worker upload and dispatch.
- Bundle the exact `@cloudflare/computer` installed by Weft, use it with real
  Durable Object SQLite, and check filesystem writes and separation of owners.
- Exercise Weft's actual Access assertion verifier without a signed identity.
  This is an authentication rejection test, not successful interactive login.
- Upload Weft's own `dist/dynamic-worker.js` fixture and execute its Cordis
  runner with scoped RPC, blocked outbound fetch and no platform secret access.
- Exercise the actual native plugin platform's facets, lifecycle, stale callback
  rejection and separation of owners.
- Upload the unmodified Weft main module to test module admission. This does not
  deploy its full product bindings or provide a working Weft service.
- Attempt trace-enabled upload metadata corresponding to Weft's configuration.
- Compare Weft's FUSE test requirements with the pinned Broker device/capability
  policy and run its actual computerd image without additional FUSE privileges.

Reports and Kubernetes logs are uploaded as the `weft-compatibility` artifact.
`report.json` and `report.md` identify passed probes and blockers separately.
The audit does not enable privileged mode or relax the Broker's device policy.

## Local use

Build a checkout of the pinned Weft revision using its own `npm ci` and
`npm run build`. Start an isolated open-compute `0.4.0` instance, then run:

```bash
WEFT_DIR=/path/to/built/Weft \
OPEN_COMPUTE_SOURCE=/path/to/open-compute \
OPEN_COMPUTE_ORIGIN=http://127.0.0.1:8787 \
OPEN_COMPUTE_TOKEN="$TEST_ADMIN_TOKEN" \
node .github/scripts/weft-compatibility.mjs --strict
```

Set `WEFT_CONTAINER_IMAGE` to the image built by
`node scripts/workspace-container.mjs --local` to include the actual computerd
mount probe. Without that image, only the source-level FUSE requirement review
runs. Test only disposable instances: the probe creates Workers and DO data.
