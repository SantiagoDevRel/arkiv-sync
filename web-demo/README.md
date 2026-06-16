# arkiv-sync — hosted live demo

The shareable, always-on demo of [`arkiv-sync`](https://www.npmjs.com/package/arkiv-sync):
point it at any contract on a built-in EVM chain and watch its events become a **queryable Arkiv
database**, live. Deployed at **https://arkiv-indexer.vercel.app** (team `santiago-hobby`).

> It **dogfoods the published npm package** — the serverless functions `import` from `arkiv-sync`
> (not a local copy), so the demo is also a proof the package works as shipped.

## Why this is a Vercel build, not the 24/7 worker

The library's normal mode is an infinite `start()` loop — that can't live on request-scoped
serverless. So this demo runs a **bounded pass per request**: one `/api/run` call drives
`runOnce()` until caught up **or** a hard budget hits (≈45s wall-clock under the 60s `maxDuration`,
`MAX_WRITES`, `MAX_BACKFILL`, `maxEventsPerTick`), streaming each `onActivity` over SSE, then ends.
No loop, nothing to leak. For a real 24/7 worker, run the library on a long-running host.

## Endpoints

| Route | What | Signs? |
|---|---|---|
| `GET /` | the split-screen UI (source events → Arkiv writes, live) | — |
| `GET /api/chains` | built-in source chains for the selector | no |
| `GET /api/abi?address=&chain=` | resolve event signatures (Sourcify, keyless) | no |
| `GET /api/run?contract=&event=&chain=&mode=&backfillBlocks=` | **SSE** bounded index pass | yes (Braga) |
| `GET /api/query?contract=&chain=` | **read-only** — query the derived DB back out (the headline verb) | no |

## Safety / rate-limiting (it's a public URL with a funded testnet burner)

- The burner `PRIVATE_KEY` lives **only** as a Vercel env var — never in the repo, never sent to the
  browser, never uploaded (`.vercelignore` excludes `.env`). It signs **Braga testnet** writes only
  (the library refuses any non-allowlisted / mainnet chain).
- Per-run hard caps (time budget · max writes · max backfill depth · `maxEventsPerTick`) bound the
  cost (testnet GLM, ~0) and runtime. Best-effort single-flight per warm instance avoids burner
  nonce contention. A fully hardened public version would add a cross-instance rate-limit (KV) + an
  auth gate on `/api/run` — documented follow-up, not built (this is a demo).

## Deploy

```bash
# from this folder, linked to santiago-hobby/arkiv-indexer
vercel env add PRIVATE_KEY production   # a funded Braga testnet burner (server-side only)
vercel deploy --prod --yes --scope santiago-hobby
```

Node is pinned to `22.x` (never 24 — it hangs Arkiv updates). `vercel.json` sets `maxDuration: 60`.
