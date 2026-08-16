# DSH Hub Workshop

Plugin intake and current-baseline verification are documented in [INTAKE.md](INTAKE.md) and [INTAKE.zh.md](INTAKE.zh.md). The three integration modes are transactional Profile Bundle, managed Repository Plugin configuration, and guided integration; pending review is an independent review state.

The public market, plugin Catalog, review projection, and immutable feed authority for the OMDSH ecosystem. The production site is [hub.omdsh.dev](https://hub.omdsh.dev/), with [hub.0.org.cn](https://hub.0.org.cn/) as a byte-equivalent fallback.

The website is public and does not use visitor GitHub OAuth, a member allowlist, or a login session. Repository visibility is discovery evidence only: it never grants installation authority. Installable entries must be reviewed and emitted by `registry-v1.json` with an immutable source coordinate.

The market has three separate layers. Leaf plugins remain in `catalog.json`; ecosystem infrastructure and community distributions are curated in `market-layers.json`; installation authority remains exclusively in `registry-v1.json`. Infrastructure and distributions may therefore be discoverable without being labeled or installed as plugins. Awesome lists, documentation-only repositories, templates, placeholders, and popularity-only Topic matches remain outside every market layer.

The architecture keeps production decentralized and trust facts centralized: authors retain source, Issues, and releases in their repositories; Workshop records immutable coordinates, classification, review state, and verification evidence. Market visibility, plugin qualification, current-baseline verification, and Registry admission are four separate states.

The `dsh-plugin` Topic is a candidate source, not the Catalog. `topic-plugin-audit.json` requires file-level plugin evidence and excludes core products, ecosystem infrastructure, distributions, awesome lists, documentation, templates, standalone applications, placeholders, unavailable private sources, and Topic-only repositories from the plugin layer. Run `npm run topic:audit` to refresh the evidence report and `npm run topic:apply` to apply it to an existing Catalog snapshot.

`registry-admissions.json` is the review source. `npm run feeds:build` verifies each evidence digest and regenerates the Catalog, Registry, Workshop, Run Record, Recipe, Collection, and Agent ecosystem projections deterministically. The public Registry artifact is unsigned and reproducible; a remote consumer must verify the production Ed25519 signature against `registry-trust-roots.json`, while a bundled consumer snapshot may explicitly accept the unsigned build artifact. Production signing fails unless the private key matches the active published trust root.

## Validate

```sh
npm ci
npm run feeds:build
npm run validate
npm run deploy:dry-run
```

## Deploy

Production deployment replaces the existing `dsh-hub` Cloudflare Worker version for both hostnames. It requires only a Cloudflare deployment token and account ID; no GitHub visitor identity or OAuth secret is used by the Worker.

Cloudflare Web Analytics uses automatic setup for the `omdsh.dev` zone, which covers both Worker routes. The Worker permits the Cloudflare beacon in its CSP but never injects a second beacon, so each visit is counted once. Local and preview hosts remain outside the production analytics setup.

```sh
npm run deploy
```
