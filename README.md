# DSH Hub Workshop

Plugin intake and current-baseline verification are documented in [INTAKE.md](INTAKE.md) and [INTAKE.zh.md](INTAKE.zh.md). The three integration modes are transactional Profile Bundle, managed Repository Plugin configuration, and guided integration; pending review is an independent review state.

The public market, plugin Catalog, review projection, and immutable feed authority for the OMDSH ecosystem. The production site is [hub.omdsh.dev](https://hub.omdsh.dev/), with [hub.0.org.cn](https://hub.0.org.cn/) as a byte-equivalent fallback.

The website is public and does not use visitor GitHub OAuth, a member allowlist, or a login session. Repository visibility is discovery evidence only: it never grants installation authority. Installable entries must be reviewed and emitted by `registry-v1.json` with an immutable source coordinate.

The market has three separate layers. Leaf plugins remain in `catalog.json`; ecosystem infrastructure and community distributions are curated in `market-layers.json`; installation authority remains exclusively in `registry-v1.json`. Infrastructure and distributions may therefore be discoverable without being labeled or installed as plugins. Awesome lists, documentation-only repositories, templates, placeholders, and popularity-only Topic matches remain outside every market layer.

The architecture keeps production decentralized and trust facts centralized: authors retain source, Issues, and releases in their repositories; Workshop records immutable coordinates, classification, review state, and verification evidence. Market visibility, plugin qualification, current-baseline verification, and Registry admission are four separate states.

The `dsh-plugin` Topic is a candidate source, not the Catalog. Community plugin repositories must have a GitHub `created_at` at or after `2026-07-31T00:00:00Z`; missing creation time fails closed, while official owner exemptions are explicit and identity-based. A native DSH plugin must also bind a versioned production/peer/optional `@deepseek-ai/dsh*` dependency to a real runtime entry, patch, or plugin manifest. Wildcards, `workspace:`/local specs, `devDependencies`, Topics, names, descriptions, and README claims never qualify a project by themselves. MCP, Skill, and Repository Plugin projects instead require their protocol-specific formal manifests and artifacts. Automatically discovered infrastructure also needs a versioned, linked DSH dependency and a real runtime entry; distributions require fixed-source human review. `topic-plugin-audit.json` excludes core products, awesome lists, documentation, templates, standalone applications, placeholders, unavailable private sources, and Topic-only repositories from public market surfaces. Run `npm run topic:audit` to refresh the evidence report and `npm run topic:apply` to apply it to an existing Catalog snapshot.

`registry-admissions.json` is the review source. `npm run intake:sync-evidence` projects passed typed Harness reports into Intake without granting approval. A maintainer inspects an exact Release with `npm run registry:approve -- inspect <project@version>` and records the one human decision with `npm run registry:approve -- approve <project@version> --reviewer <identity>`; eligible Profile admission and every downstream Feed are then generated automatically. Guided protocols remain Catalog-only, and a blocked Harness report remains non-installable.

The Builder supports two deliberately separate paths. A local `omdsh-pack-source/v1` Experimental Pack can combine Registry Releases with the author's own Profile Bundle pinned to a public GitHub repository and full commit; it records every component's SPDX expression and source, but requires explicit local trust and is never public installation authority. A trusted community distribution remains Registry-only.

Trusted community distributions have a separate, cheaper composition review. The `[Distribution]` Issue workflow fetches an `omdsh-distribution/v1` manifest from an exact public commit, rejects any component that is not already installable in the current Registry snapshot, and opens a pending-review PR without executing author code. The Builder and generated feed list each resolved component license and its source; this inventory does not make a legal compatibility decision. A maintainer uses `npm run distribution:approve -- inspect <distribution@version>` and then `npm run distribution:approve -- approve <distribution@version> --reviewer <identity>` for the single human composition decision. The resulting `distributions-v1.json` is independent from `registry-v1.json`: it resolves only existing Release IDs and can never elevate component trust or installation authority.

`npm run feeds:build` verifies each evidence digest and regenerates the Catalog, Registry, Workshop, Run Record, Recipe, Collection, and Agent ecosystem projections deterministically. The repository `registry-v1.json` stays unsigned and reproducible. Production deployment signs only `.public-site/registry-v1.json` with Ed25519 using `OMDSH_REGISTRY_SIGNING_KEY_B64` and `OMDSH_REGISTRY_SIGNING_KEY_ID`; remote consumers must verify that signature, while a bundled consumer snapshot may explicitly accept the unsigned build artifact.

## Validate

```sh
npm ci
npm run feeds:build
npm run distributions:build
npm run validate
npm run deploy:dry-run
```

## Deploy

Production deployment replaces the existing `dsh-hub` Cloudflare Worker version for both hostnames. It requires a Cloudflare deployment token and account ID plus the Ed25519 Registry signing secret and key ID; no GitHub visitor identity or OAuth secret is used by the Worker.

Cloudflare Web Analytics uses automatic setup for the `omdsh.dev` zone, which covers both Worker routes. The Worker permits the Cloudflare beacon in its CSP but never injects a second beacon, so each visit is counted once. Local and preview hosts remain outside the production analytics setup.

```sh
npm run deploy
```
