# Workshop 插件入库与验证流程

这套流程把五件事分开记录：**接入类型、安装/隔离能力、生命周期能力、审核与验证状态、Registry 准入**。Catalog 收录或 Topic 命中都不会自动获得安装权限。

新投稿的事实入口是固定 commit 中的 `package.json#dshWorkshop`（`omdsh-workshop-package/v1`）。旧式 `dsh.bundle`、`.dsh-plugin`、Skill 或 MCP 文件证据只保留为兼容映射；未补新 manifest 前，平台把无缝安装、失败隔离和热重载全部保持为未知。

这套入库流程只适用于叶子插件层。生态基础设施和社区发行版通过 `market-layers.json` 单独策展，不进入插件验证库存，也不会仅因市场展示获得 Registry 准入。

当前官方公开基线为 `@deepseek-ai/dsh@0.1.0-rc.6`。它是官方当前公开版本，但仍是 RC，不是稳定 GA。每次官方基线改变，所有可安装条目都必须重新验证；旧证据只能保留为历史记录。

## 三种接入类型

| 类型 | 投稿契约 | 当前状态 | 必须通过的测试 | Registry |
|---|---|---|---|---|
| 事务安装 | `profile-bundle` / `harness-profile` | RC.6 有公开 Profile/Bundle 生命周期 | 固定来源、供应链、安装、就绪、功能、升级、禁用、移除、恢复 | 审核与当前基线验证均通过后可准入 |
| 配置接入候选 | `repository-plugin` / `harness-repository` | 当前公开 RC.6 未提供对应包、Schema 和 Loader | 保留静态证据；公共契约可核验后重跑完整生命周期 | 当前自动阻断 |
| 引导接入 | `guided` / `harness-cordis`、`mcp`、`skill` 或 `third-party` | 只提供固定公开来源和说明；MCP 可单独做隔离协议测试 | 固定来源、许可、权限与供应链；可执行隔离测试不等于 DSH 安装授权 | 永不直接准入 |

`pending-review`（待审核）是审核状态，不是第四种安装方式。一个事务安装、配置安装或引导接入投稿都可以处于待审核状态。

## 入库状态机

```text
公开固定 commit 投稿
  → 产品边界筛选（排除主仓、基础设施、发行版、目录、模板）
  → 定位真正的根包或插件子包
  → 自动校验 Manifest、公开仓库、固定 commit 和声明路径（不执行投稿代码）
  → 自动生成 pending-review Intake Record 与审核 PR
  → 兼容性、权限与供应链审查（许可、原生代码、安装脚本、漏洞）
  → 分类型验证
      transactional → RC.6 完整生命周期
      managed       → 当前因官方公共契约缺失而 blocked
      guided        → 来源与说明验证，不运行安装
  → 对可执行接入明确断言一个能力已注册、已调用、结果已观察
  → 人工审核 approved / needs-fix / blocked
  → 只有 approved + current-baseline-passed 才能 eligible
  → 维护者显式 admission 后才进入 Registry
```

Topic、关键词和仓库自述只负责进入候选池。根目录没有可安装包时，必须继续定位真实插件子包；插件管理器、SDK、宿主、导航目录、模板或插件合集不能整体冒充一个插件。静态结构相似也不等于可用：运行验证必须写明目标工具、命令、服务、UI 扩展、事件或 Provider，实际调用并记录预期结果与观察结果。仅仅“进程启动成功、退出码为 0”只算加载冒烟，不算功能验证。

## 五项能力测试

| 平台字段 | 变为“已验证”的最低条件 |
|---|---|
| 无缝安装 | candidate 安装、就绪、真实功能、升级、禁用、移除、代际恢复全部通过，且来源固定、安装脚本禁用 |
| 失败可丢弃 | 注入安装错误与启动错误，证明只丢弃 candidate 或 MCP 隔离进程，启用前 current 未变化 |
| 热重载 / 热重启 | 按 manifest 的 activation 执行；hot-reload 必须观察 dispose、资源释放、重新激活和一次真实能力调用 |
| 接入方式 | Profile、Repository、Cordis、MCP、Skill 或第三方制品与声明相符；MCP 使用官方 `server.json`，协议 `2026-07-28` |
| 社区收录 | v2 submission 与固定 commit 的 `package.json#dshWorkshop` 逐值一致，随后通过静态、权限、供应链和人工审核 |

作者声明只会显示“已声明”。没有对应证据路径、证据文件不存在、测试环境不匹配或结果不可复现时都不能升级为“已验证”。MCP 的独立进程失败可丢弃，只证明隔离边界；它不会自动获得 DSH Profile 安装或 Registry 权限。

入库记录使用 `intake.schema.json`，分类型计划使用 `harness-plan.schema.json`，执行报告使用 `harness-report.schema.json`，运行证据使用 `intake-evidence.schema.json`，公开队列为 `intake-queue.json`，当前官方事实为 `official-baseline.json`。新 v2 投稿必须使用 Harness 生成的 v2 证据；CI 全部做 fail-closed 校验。

### 真实项目逐项审查

遗留 Catalog 候选不能批量继承旧验证。`npm run intake:review-real` 会按项目串行执行匿名公开 Git 固定、类型计划预检和辅助静态信任审查，并把一项目一文件的结果写入 `intake/reviews/`。缺少 `package.json#dshWorkshop`、固定版本不一致、仍锁旧 Runtime 或依赖未公开 Repository Plugin 契约的项目会停在 adapter 之前；脚本不会执行项目代码、代替独立人工审核或写入 admission。

```bash
# 串行审查当前遗留真实候选
npm run intake:review-real

# 只重新审查一个项目
npm run intake:review-real -- --id 7d7d

# 离线校验已保存的逐项目证据和零授权事实
npm run intake:review-check
```

顺序固定为：公开 commit → 类型计划 → 人工信任门禁 → 对应 adapter → report/evidence → 独立人工审核 → 单独 admission。任何前置阶段失败都必须保持 `RC.6 verified=false`。

`verification-inventory.json` 对 Catalog 每一个项目给出当前接入处理、审核、官方基线验证和 Registry 状态。未知项目只能使用引导式公开处理；它们不会因为出现在 Catalog 就被视为完成测试。

## 本地命令

```bash
# 校验 Author Studio 清单，只读，不执行投稿仓库代码
npm run intake:validate -- /path/to/submission.json

# 生成待审核记录到标准输出；不会自动写入队列
npm run intake:prepare -- /path/to/submission.json

# 按 Profile、Repository、MCP、Cordis、Skill 或第三方类型生成只读计划
# 只生成计划，不执行投稿代码
npm run harness:plan -- /path/to/submission.json

# 将已通过的 Harness report 转换成 v2 Intake evidence
npm run harness:evidence -- intake/records/project@version.json harness-report.json environment.json

# CI 使用：从 GitHub Issue 解析清单并完成公开固定来源预检
npm run intake:issue -- /path/to/github-event.json

# 将 intake/records/*.json 确定性生成公开队列
npm run intake:build

# 把已保存的记录与运行证据合并成下一版记录（输出到标准输出）
npm run intake:evidence -- intake/records/project@version.json intake/evidence/project@version.json

# 校验当前队列、官方基线、admissions 与 Registry 一致性
npm run intake:check

# 联网核验 npm 上的官方版本、integrity 及未开放包状态
npm run baseline:verify

# 维护者本地 adapter 回归：Skill 只做静态检查，绝不执行 Skill
npm run harness:skill

# 维护者本地 adapter 回归：在 deny-network 子进程中验证 MCP 2026-07-28
npm run harness:mcp

# 维护者本地 adapter 回归：安装精确 RC.6 后验证完整 Profile 生命周期
npm run harness:profile

# 按 Skill → MCP → Profile 的顺序执行以上三类本地夹具
npm run harness:verify

# 全量构建与测试
npm run validate
```

以上四个 `harness:*` 回归命令只使用仓库内维护者夹具，输出不能直接作为任何社区项目的入库证据。真实投稿必须另行固定公开 commit、完成人工信任判断，再交给对应 adapter；adapter 会自行核对 Git `origin`、HEAD、投稿子路径和干净工作树，不能只相信调用方传入的 commit 字符串。不得把“不存在于夹具中的项目”套用为已验证。Profile 命令只在安装精确 `@deepseek-ai/dsh@0.1.0-rc.6` 时联网，随后 RC.6、pnpm 与插件进程在临时工作区内执行，禁网、禁安装脚本，并在结束时强制清理。MCP 通过 `server/discover → tools/list → tools/call` 验证，崩溃工具只能终止其隔离子进程。Skill adapter 只解析 frontmatter、引用、路径、链接、文件类型和命令文本，不执行 Skill 中的任何指令。

当前隔离执行器要求 macOS `sandbox-exec`。每次创建沙箱都会先自检“工作区内可写、工作区外不可写、不能创建网络 socket”；任一断言失败，整份 report 失败关闭。其他平台必须先提供等价的强制隔离器，不能退化为无沙箱执行。

Author Studio 会把完整清单直接带入 GitHub Issue。Issue 创建后，`intake` 工作流只读核验公开仓库、完整 commit 和声明路径；通过后，由 `github-actions[bot]` 在独立分支写入 `pending-review` 记录、重建队列并创建审核 PR。自动化不克隆投稿仓库、不执行其脚本、不批准投稿，也不写 Registry。维护者仍须在 PR 中完成人工边界审核；运行证据保存在 `intake/evidence/`，正式安装准入仍须通过独立 admission 变更发布。

## 证据最低要求

- 来源必须是公开 GitHub 仓库和完整 40 位 commit；不接受 `main`、分支或浮动 tag。
- 测试必须记录精确 Runtime 包、版本与 integrity；只写“兼容最新版”无效。
- 供应链至少记录许可、权限、install scripts、native code、漏洞扫描和外部副作用。
- 静态证据必须分别说明清单、声明入口、DSH 专属注册路径、兼容区间与权限；不能只写“结构正确”。
- Profile、Repository Plugin、Cordis 与 MCP 必须在固定 package manifest 中填写结构化 `capability` 断言；Skill 与纯第三方说明不得声明运行时能力。Harness 计划固定该断言，adapter 回报的 ID、类型、调用方式和预期必须完全一致，并另行记录实际观察值；仅加载成功不得通过。
- 事务安装与未来恢复的配置安装均须验证 install、ready、functional、update、disable、remove、recovery、failureIsolation；声明 hot-reload 时还必须验证 dispose 与 reactivate。
- 引导接入必须保持无可执行安装意图；只能显示固定来源和阅读说明。
- 一旦官方 baseline 改变，旧 `current-baseline-passed` 自动视为过期，不得继续进入 Registry。
