# DSH Hub Workshop: author-Agent submission instruction

You are working inside an author's repository that is ready for DSH Hub Workshop submission. Complete this flow: read verifiable facts, generate the manifest, validate it locally, show the exact proposed Issue, and create the Issue only after the author confirms that specific GitHub write. The target is always `omdsh-dev/dsh-hub-workshop`, and the Issue must remain compatible with existing `[Submission]` Issues.

## Boundaries

- Read every applicable `AGENTS.md`, README, license, package manifest, lockfile, entry point, build configuration, and test first.
- Never print, copy, or submit tokens, secrets, private links, personal absolute paths, machine-local configuration, or other sensitive data.
- Submit only an existing immutable source in a PUBLIC repository. The Release must use a full 40-character commit SHA already readable from the public remote. A branch, short SHA, floating tag, or unpushed commit is invalid.
- Do not run submitted install scripts, remote scripts, or unknown binaries. Read source and static assets; run an existing project check only after assessing its purpose and risk.
- Never edit DSH Hub Workshop Catalog, Registry, Workshop feeds, generated pages, or signatures. The Workshop automation creates a `pending-review` PR after the Issue is opened.
- Never describe discovery, a clean static scan, or an opened Issue as security approval, official compatibility, or installation eligibility. Registry authority remains zero until separate review and test gates pass.
- Do not commit, push, create a Release, change repository visibility, or create an Issue without the operation-specific approval required by the current environment.

## Procedure

1. Audit the project read-only. Determine the project root or monorepo subpath, real purpose, entry points, version, GitHub author, license, dependencies, permissions, external effects, tests, compatibility, and current integration method. Record unverifiable facts as unknown or undeclared; do not guess.

2. Check Git state and the remote:
   - uncommitted working-tree changes must not become submission facts;
   - `release.ref` must identify a full commit already present on the intended public remote;
   - verify anonymously that the repository, commit, and declared subpath are public and readable. Stop if the repository is private, the commit is unpushed, or the path is missing, and explain what the author must complete first.
   - Require the submitted package's `package.json#dshWorkshop` to conform to `https://hub.omdsh.dev/package-manifest.schema.json`. If it is absent, prepare the proposed snippet and stop. Resume only after the author reviews, commits, and pushes a new pinned commit; never treat a local-only manifest as admission evidence.

3. Select exactly one `management.method` from actual artifacts:
   - `profile-bundle` only for a real Profile Bundle with an immutable package spec and matching artifacts; use `harness-profile`.
   - `repository-plugin` only when `.dsh-plugin/package.json` actually exists at the fixed commit; use `harness-repository` and pin `source` to that `.dsh-plugin` directory. A publicly unverifiable contract remains blocked and must not be described as installable.
   - `guided` for every other Skill, MCP, Cordis integration, Web UI, adapter, or third-party format; use `harness-cordis`, `mcp`, `skill`, or `third-party`, set `source` to `null`, and provide non-executable pinned-source guidance without an install command. MCP requires the official `server.json`, protocol version `2026-07-28`, and Registry schema `2025-12-11`; an npm MCP package's `package.json#mcpName` must match `server.json#name`.

4. Generate JSON that conforms exactly to `https://hub.omdsh.dev/submission.schema.json` without extra fields:
   - `schema` is `omdsh-workshop-submission/v2`;
   - `packageManifest` exactly matches `package.json#dshWorkshop` at the pinned commit and separately declares install mode, failure policy, whether current is touched before activation, hot reload/restart, dispose, structured permissions, and evidence paths. Profile, Repository Plugin, Cordis, and MCP submissions also name one concrete `capability` (ID, kind, invocation, and expected observation); loaded/started alone is not functional evidence;
   - `operation` is `create-project` or `add-release`;
   - use `null` for a repository-root `project.path`, otherwise a path beginning with `/`;
   - use a full 40-character `release.ref` and a verifiable ISO 8601 `updatedAt`;
   - truthfully declare permissions, tests, compatibility, restart, Fabric, deep hooks, install scripts, and external effects;
   - set `installScriptsMustRemainDisabled` to `true`;
   - never invent version, authorship, license, compatibility, downloads, test results, rollback, or official status.

5. Write the JSON only to an operating-system temporary directory. Clone the public `omdsh-dev/dsh-hub-workshop` into another temporary directory, record its current commit, and run:

   ```text
   node <workshop-temp>/scripts/intake.mjs validate <submission-temp>.json
   ```

   Correct factual manifest errors or report a blocker; never weaken the validator. Preserve the command, Workshop commit, and result summary in the report before removing temporary files.

6. After validation succeeds, prepare this Issue for `omdsh-dev/dsh-hub-workshop`:

   - title: `[Submission] <project.id>@<release.version>`
   - body:

     ````markdown
     ### Author Studio manifest

     ```json
     <complete omdsh-workshop-submission/v2 JSON>
     ```

     ### Submission boundary

     - This request contains only public, immutable source coordinates and the generated structured manifest.
     - Automated intake may create a pending-review PR, but cannot approve the project or grant Registry installation authority.

     ### Confirmations

     - [x] The repository and pinned commit are public.
     - [x] Permissions, tests, compatibility, and external effects are declared from verifiable evidence.
     - [x] No credential, private path, or private data is included.
     ````

7. Before any credentialed access or GitHub write, show the author:
   - the GitHub account to be used;
   - target repository `omdsh-dev/dsh-hub-workshop`;
   - the purpose: creating exactly one public submission Issue;
   - the Issue title;
   - the complete Issue body.

   Stop and wait for explicit confirmation of that exact operation. Do not infer it from earlier broad approval.

8. After confirmation, use the environment's supported GitHub connector, API, or signed-in browser to create only that Issue. Do not also commit, push, create a Release or PR, or perform another write. Read the result immediately and verify its repository, title, and body, then return the public Issue URL. If creation fails, do not retry blindly; first search for an Issue with the same title and pinned commit.

The final report contains only the detected project form, pinned repository/path/commit, manifest-validation result, created Issue URL, and remaining human review or testing requirements.
