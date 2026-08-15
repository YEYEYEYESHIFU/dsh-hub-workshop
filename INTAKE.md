# Workshop plugin intake and verification

The intake system records five independent dimensions: **integration mode, install/isolation capability, lifecycle capability, review and verification state, and Registry admission**. Catalog inclusion, a Topic match, or historical preview evidence never grants installation authority.

New submissions bind to `package.json#dshWorkshop` (`omdsh-workshop-package/v1`) at the pinned commit. Legacy `dsh.bundle`, `.dsh-plugin`, Skill, and MCP artifacts remain compatibility-mapped, with seamless install, failure isolation, and hot reload kept unknown until authors adopt the manifest and tests pass.

This intake applies only to the leaf-plugin layer. Ecosystem infrastructure and community distributions use the curated `market-layers.json` projection, remain outside plugin verification inventory, and are always ineligible for Registry admission through market listing alone.

The current official public baseline is `@deepseek-ai/dsh@0.1.0-rc.6`. It is an official public release candidate, not stable GA. Every installable entry must be reverified whenever that baseline changes.

## Integration modes

| Mode | Submission contract | Current status | Required tests | Registry |
|---|---|---|---|---|
| Transactional | `profile-bundle` / `harness-profile` | Public RC.6 exposes the Profile/Bundle lifecycle | pinned source, supply chain, install, ready, functional, update, disable, remove, recovery | eligible only after review and current-baseline evidence |
| Configuration candidate | `repository-plugin` / `harness-repository` | its package, schema, and loader are not present in the current public RC.6 contract | preserve static evidence; rerun the full lifecycle when a public contract can be verified | blocked today |
| Guided | `guided` / `harness-cordis`, `mcp`, `skill`, or `third-party` | pinned public source and guidance; MCP may receive an independent isolated protocol test | source, license, permissions, supply-chain, and optional isolated protocol evidence | never directly eligible |

`pending-review` is a review state, not a fourth installation mode.

## State machine

```text
pinned public commit submission
  → product-boundary filter (exclude core, infrastructure, distributions, directories, templates)
  → locate the actual root package or plugin subpackage
  → automated manifest, public repository, fixed commit, and declared-path preflight
  → automated pending-review record and review PR
  → compatibility, permissions, and supply-chain review
  → mode-specific verification
  → assert one named capability was registered, invoked, and observed
  → approved / needs-fix / blocked review decision
  → approved + current-baseline-passed = eligible
  → explicit maintainer admission = Registry publication
```

Topic and keyword matches only create discovery candidates. A repository with no installable root package must be inspected at its real subpackage path; a manager, SDK, host, directory, template, or plugin collection is not admitted as one plugin. Static resemblance is not enough: a runtime pass must identify the exact tool, command, service, UI contribution, event, or provider, invoke it, and record expected versus observed behavior. A process that merely starts and exits successfully counts only as a smoke test.

## Five capability gates

| Platform fact | Minimum evidence for Verified |
|---|---|
| Seamless install | candidate install, ready, real capability, update, disable, remove, and generation recovery all pass with pinned source and install scripts disabled |
| Disposable failure | injected install and startup failures discard only the candidate or isolated MCP process and leave current unchanged before activation |
| Hot reload / restart | execute the declared activation; hot reload observes dispose, resource cleanup, reactivation, and one real capability invocation |
| Integration protocol | the Profile, Repository, Cordis, MCP, Skill, or third-party artifact matches its declaration; MCP uses official `server.json` and protocol `2026-07-28` |
| Community admission | the v2 submission exactly matches fixed `package.json#dshWorkshop`, then passes static, permissions, supply-chain, and human review |

Author declarations display only as Declared. Missing evidence paths, absent evidence files, environment mismatches, or non-reproducible results cannot become Verified. A disposable MCP process proves isolation only; it never grants DSH Profile or Registry installation authority.

Records use `intake.schema.json`, typed plans use `harness-plan.schema.json`, execution reports use `harness-report.schema.json`, runtime evidence uses `intake-evidence.schema.json`, the public queue is `intake-queue.json`, and `official-baseline.json` records current upstream facts. New v2 submissions require Harness-produced v2 evidence; CI validates every boundary fail-closed.

### One real project at a time

Legacy Catalog candidates do not inherit historical verification in bulk. `npm run intake:review-real` processes them sequentially: it anonymously fixes the public Git commit, attempts a typed-plan preflight, and records an assisted static trust review in one file per project under `intake/reviews/`. A missing `package.json#dshWorkshop`, release mismatch, legacy Runtime pin, or unavailable Repository Plugin contract stops the case before any adapter runs. The command never executes project code, substitutes for independent human review, or writes an admission.

```bash
npm run intake:review-real
npm run intake:review-real -- --id 7d7d
npm run intake:review-check
```

The enforced order is: public commit → typed plan → human trust gate → matching adapter → report/evidence → independent human review → separate admission. A failed prerequisite always preserves `RC.6 verified=false`.

`verification-inventory.json` accounts for every Catalog project across public handling, review, current-baseline verification, and Registry state. Unknown projects receive guided public handling and are never presented as tested merely because they appear in Catalog.

## Commands

```bash
npm run intake:validate -- /path/to/submission.json
npm run intake:prepare -- /path/to/submission.json
npm run harness:plan -- /path/to/submission.json
npm run harness:evidence -- intake/records/project@version.json harness-report.json environment.json
npm run intake:issue -- /path/to/github-event.json
npm run intake:build
npm run intake:evidence -- intake/records/project@version.json intake/evidence/project@version.json
npm run intake:check
npm run baseline:verify
npm run harness:skill
npm run harness:mcp
npm run harness:profile
npm run harness:verify
npm run validate
```

The four `harness:*` adapter commands above use maintainer-owned repository fixtures only; their output is never admission evidence for a community project. A real submission still needs a pinned public commit, an explicit trust decision, and its own adapter run. The adapter independently checks Git `origin`, HEAD, the submitted subpath, and a clean worktree instead of trusting a caller-supplied commit string. The Profile command uses the network only to install exact `@deepseek-ai/dsh@0.1.0-rc.6`; RC.6, pnpm, and plugin execution then run in an ephemeral workspace with network and install scripts disabled. MCP verifies `server/discover → tools/list → tools/call` and contains the crashing tool in its child process. Skill inspection parses frontmatter, references, paths, file types, and command text without executing the Skill.

The current isolated executor requires macOS `sandbox-exec`. Every sandbox first proves that workspace writes succeed, writes outside the workspace fail, and network sockets cannot be created. A failed assertion fails the report closed. Other platforms need an equivalent enforced executor and must never fall back to unsandboxed source execution.

Author Studio carries the complete manifest into a GitHub Issue. After the Issue is created, the `intake` workflow checks the public repository, full commit, and declared path read-only. A successful preflight lets `github-actions[bot]` write a `pending-review` record on an isolated branch, rebuild the queue, and open a review PR. Automation does not clone the submitted repository, execute its scripts, approve the submission, or write Registry state. Human boundary review, evidence under `intake/evidence/`, and a separately reviewed admission change remain mandatory. Profile, Repository Plugin, Cordis, and MCP declarations name a structured `capability`; Skill and static third-party guidance cannot claim a runtime target. The Harness plan fixes that assertion, and the adapter must return the same ID, kind, invocation, and expected observation plus the actual observed value. Executable modes cannot pass with load-only evidence. Transactional and future managed execution must additionally pass failure isolation; a declared hot reload requires dispose and reactivate evidence.
