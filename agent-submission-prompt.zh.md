# DSH Hub Workshop：作者 Agent 自动投稿指令

你正在一个准备投稿到 DSH Hub Workshop 的作者仓库中工作。请完成“读取事实 → 生成清单 → 本地校验 → 展示待提交 Issue → 经作者确认后创建 Issue”的流程。目标 Issue 固定为 `omdsh-dev/dsh-hub-workshop`，格式必须与现有 `[Submission]` Issue 兼容。

## 不可越过的边界

- 先完整读取当前仓库适用的 `AGENTS.md`、README、许可文件、包清单、lockfile、入口、构建配置和测试。
- 不输出、复制或提交 Token、密钥、私有链接、个人绝对路径、本机配置或其他敏感信息。
- 只提交公开仓库中已经存在的固定来源。仓库必须是 PUBLIC；Release 必须固定到远端可读取的完整 40 位 commit SHA。分支名、短 SHA、浮动 tag 和未推送 commit 都不合格。
- 不执行投稿仓库的安装脚本、远程脚本或未知二进制。可以读取源码和静态资产；只有作者仓库已有且用途明确的检查命令才可在评估风险后运行。
- 不直接编辑 DSH Hub Workshop 的 Catalog、Registry、Workshop feed、生成页面或签名文件；创建申请 Issue 后，由 Workshop 自动化生成 `pending-review` PR。
- 不把“被发现”“静态扫描通过”或“申请已创建”描述成安全认证、正式兼容或可安装。Registry 权限仍为 0，直到独立审核和测试门禁通过。
- 不自行 commit、push、创建 Release、改仓库可见性或创建 Issue。任何 GitHub 凭据访问和远端写入都必须遵守当前环境的授权规则。

## 执行顺序

1. 只读审计当前项目，确认项目根目录或 monorepo 子路径、真实功能、入口、版本、作者 GitHub ID、许可、依赖、权限、外部副作用、测试、兼容性和当前接入方式。无法从固定 commit 验证的事实写“未知”或“未声明”，不要猜测。

2. 核对 Git 状态和远端：
   - 工作树中的未提交改动不得进入本次申请事实；
   - `release.ref` 必须来自目标公开远端已经包含的完整 commit；
   - 用匿名公开读取核验仓库、commit 和申报子路径均可访问；如果仓库为 PRIVATE、commit 未推送或路径不存在，停止并说明需要作者先完成什么。
   - 申报包的 `package.json#dshWorkshop` 必须符合 `https://hub.omdsh.dev/package-manifest.schema.json`。如果缺失，先生成建议片段并停止，等待作者审阅、提交和推送新的固定 commit 后再申请；不要把临时生成但未进入远端 commit 的 manifest 当成收录事实。

3. 根据仓库真实制品只选择一种 `management.method`：
   - `profile-bundle`：只有真实提供 Profile Bundle、固定 package spec 和对应制品时使用；`protocol` 为 `harness-profile`。
   - `repository-plugin`：只有固定 commit 中真实存在 `.dsh-plugin/package.json` 时使用；`protocol` 为 `harness-repository`，`source` 必须固定到该 `.dsh-plugin` 目录。当前公开契约不可核验时仍会被阻断，不得声称可安装。
   - `guided`：其余 Skill、MCP、Cordis、Web UI、Adapter 或第三方格式使用；`protocol` 可为 `harness-cordis`、`mcp`、`skill` 或 `third-party`，`source` 为 `null`，`instructions` 只给固定来源的非执行说明，不得包含可直接执行的安装命令。MCP 必须同时提供官方 `server.json`，使用 `2026-07-28` 协议版本与 `2025-12-11` Registry schema；npm MCP 的 `package.json#mcpName` 必须与 `server.json#name` 相同。

4. 直接生成一份严格符合以下契约的 JSON，不要添加契约外字段：
   - schema：`https://hub.omdsh.dev/submission.schema.json`
   - `schema` 固定为 `omdsh-workshop-submission/v2`
   - `packageManifest` 必须与固定 commit 中的 `package.json#dshWorkshop` 完全一致，分别声明安装模式、失败处置、是否在启用前触碰 current、热重载/重启、dispose、结构化权限和证据路径；Profile、Repository Plugin、Cordis 与 MCP 还必须声明一个具体 `capability`（ID、类型、调用方式、预期观察），不能用 loaded/started 代替功能验证
   - `operation` 只能是 `create-project` 或 `add-release`
   - `project.path` 无子路径时为 `null`，有子路径时以 `/` 开头
   - `release.ref` 为完整 40 位 commit；`updatedAt` 为可验证的 ISO 8601 时间
   - 权限、测试、兼容性、重启、Fabric、深层 Hook、安装脚本和外部副作用必须如实声明
   - `installScriptsMustRemainDisabled` 必须为 `true`
   - 不虚构版本、作者、许可、兼容性、下载量、测试结果、回滚能力或官方身份

5. 把 JSON 写入系统临时目录，不修改作者仓库。再把公开的 `omdsh-dev/dsh-hub-workshop` 临时 clone 到另一个临时目录，记录它的当前 commit，并运行：

   ```text
   node <workshop-temp>/scripts/intake.mjs validate <submission-temp>.json
   ```

   校验失败时修正清单中的事实或报告阻塞；不要放宽校验器。删除临时目录前保留命令、Workshop commit 和结果摘要作为报告证据。

6. 校验通过后，构造以下 Issue，目标固定为 `omdsh-dev/dsh-hub-workshop`：

   - 标题：`[Submission] <project.id>@<release.version>`
   - 正文：

     ````markdown
     ### Author Studio manifest

     ```json
     <完整的 omdsh-workshop-submission/v2 JSON>
     ```

     ### Submission boundary

     - This request contains only public, immutable source coordinates and the generated structured manifest.
     - Automated intake may create a pending-review PR, but cannot approve the project or grant Registry installation authority.

     ### Confirmations

     - [x] The repository and pinned commit are public.
     - [x] Permissions, tests, compatibility, and external effects are declared from verifiable evidence.
     - [x] No credential, private path, or private data is included.
     ````

7. 在任何凭据访问或 GitHub 写入之前，向作者展示并明确说明：
   - 将使用的 GitHub 账号；
   - 目标仓库 `omdsh-dev/dsh-hub-workshop`；
   - 操作用途是创建 1 个公开申请 Issue；
   - Issue 标题；
   - Issue 完整正文。

   然后停止并等待作者对这一次具体操作的明确确认。不要把更早的宽泛授权当成本次确认。

8. 作者确认后，使用当前环境支持的 GitHub 连接器、API 或已登录浏览器创建这 1 个 Issue；不要顺带执行 commit、push、Release、PR 或其他写操作。创建后立即读取结果，核验仓库、标题和正文，并返回公开 Issue URL。若创建失败，不要重复创建，先查询是否已经存在相同标题和固定 commit 的 Issue。

最终报告只包括：识别到的项目形态、固定仓库/路径/commit、清单校验结果、实际创建的 Issue URL，以及仍需人工审核或测试的事项。
