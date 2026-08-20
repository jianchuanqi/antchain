# AGENTS.md — antchain

## Engineering OS 权威与仓库上下文来源

- 权威仓库：[jianchuanqi/tiangong-sscm-engineering-os](https://github.com/jianchuanqi/tiangong-sscm-engineering-os)
- 仓库上下文版本：`architecture-v0.1.1`
- 上下文入口：[docs/architecture-entrypoint.md](https://github.com/jianchuanqi/tiangong-sscm-engineering-os/blob/architecture-v0.1.1/docs/architecture-entrypoint.md)
- 上下文 commit：`b666efce3e5753562d9e44de9adcd245f440cdbd`

以上三项只记录本文件建立仓库角色和本地规则时采用的历史来源，不是所有未来任务的执行基线或架构版本上限。本文件只声明本仓库规则，不复制整套 Engineering OS 文档；不得静默改写这组来源记录。

## 任务架构基线

每个 SSCM Issue 必须在正文中同时固定不可移动的架构 tag、该 tag 下的入口链接和解引用后的完整 commit。执行和复核以当前 Issue 的这组 Task architecture baseline 为准；经 Issue 明确批准、三项一致且未被弃用的其他版本（包括 `architecture-v0.1.2`）可以使用。不得用 `main`、`latest`、`current version` 或其他可移动引用代替；任务基线缺失、三项不一致、未经记录升级，或与仓库边界冲突时必须停止并请求裁决。

## 仓库角色

- 项目类型：TianGong SSCM 成员中的 **SSCM Trust Infrastructure / blockchain and TCS capability**。
- 运行与部署位置：能力可表现为 Deno 客户端/服务或合约工具；本仓库不运行在 DeepSeek Harness（DSH）中，也不是 Connector 节点。
- 当前职责：为明确选择并锁定版本的 Exchange、Eco Design Label Platform 等业务平台提供可信计算、链客户端和合约能力。
- DSH 是 Connector 全部 Plugin 的统一 Runtime，不是普通 SDK；这一事实不把 AntChain 变成 DSH Plugin、Bundle 或 Connector Profile 的组成仓库。

## 本仓库负责

- TCS 客户端，以及链和可信计算适配。
- Myfish/WASM 合约及其构建、测试和脱敏研究证据。
- 研究沙箱、确定性模拟测试和与本仓能力直接相关的验证工具。
- 接受平台受控请求中的摘要、合约参数和安全配置引用，输出任务状态、结果数据集引用、交易/研究回执与合约制品。
- 适配配置、合约源码/制品和脱敏研究回执；业务数据与平台任务状态仍由调用平台拥有。

## 本仓库明确不负责

- Connector Runtime、Foundation 或 Integration Plugin、Bundle、Managed Profile、版本锁和 Connector 组合验收。
- SSCM Shared Contracts；`TIDAS-Link` 是独立兼容层，也不得并入 Contracts 或本仓库。
- Exchange、Eco Design Label Platform 等独立平台的主数据、业务身份、授权、流程和平台审计。
- 代替调用平台决定业务授权，或把未经证据支持的研究结果表述为标准终局。
- 将本仓能力默认包装成 DSH Plugin 或 Connector Sidecar；这类边界变化必须先由新的 Engineering OS 架构决策授权。

## 与其他仓库和来源的关系

- 本仓库直接 fork parent 为 `wenjie-shi-alpha/antchain`，fork network source 为 `Biaoo/antchain`。保留既有 fork 历史；上游更新必须在本仓 Issue 中评估来源、许可、差异和安全影响。
- Exchange、Eco Design Label Platform 等业务平台可按锁定版本调用本仓能力。平台侧采用、业务集成、授权和兼容验收由相应平台仓库的 Issue 负责。
- 本仓能力变化在本仓建立 Issue；若同一成果需要其他仓库修改或独立验收，先在 Engineering OS 建跨仓父 Issue，再由各 owning repository 分别实施。
- 不把其他仓库代码、业务数据、凭据或运行制品迁入本仓，除非迁移 Issue 已固定来源 commit、文件清单、许可和清理边界。

## AI 开始任务前必须读取

任何任务开始前先读取：

1. 根目录 `AGENTS.md` 和当前 Issue 的完整正文、Parent Initiative、依赖及来源清单。
2. 根目录 `README.md`、`deno.json`，以及本次范围涉及的 `docs/`、`contracts/` 或其他子目录说明。
3. 若修改 `web/`，还要读取 `web/AGENTS.md` 和 `web/package.json`；子目录规则与根规则同时适用，冲突时采用更严格者。
4. 通过 `git status`、默认分支和远程信息确认工作区、目标仓库与变更范围。

开始任何跨仓 Issue 前，还必须在当前 Issue 固定的 tag 或完整 commit 下依次读取：

1. `docs/architecture-entrypoint.md`
2. `docs/system-context.md`
3. `docs/repository-catalog.md` 中本仓库和相关仓库条目
4. `docs/integration-map.md` 中相关调用路径
5. `docs/migration-source-map.md`（涉及既有代码或数据时）
6. `docs/issue-routing.md`
7. `docs/architecture-versioning.md`
8. Issue 指定的 `docs/migration-roadmap.md` 或 `docs/release-trains.md`

## 必须停止的情况

遇到以下任一情况，立即停止受影响工作，记录事实并请求仓库或 Engineering OS owner 裁决，不得猜测：

- 当前 Issue 固定的架构 tag、入口或 commit 无法访问，三者不一致，或本地事实与其 Task architecture baseline 冲突。
- 请求会改变本仓 Trust Infrastructure 角色，或把独立平台、Connector Plugin、DSH Runtime、Shared Contracts、TIDAS-Link 的责任混入本仓。
- 一项成果需要修改多个仓库，但没有 Engineering OS 父 Issue 和逐仓实现/验收 Issue；不得直接修改其他仓库。
- 代码或数据迁移的来源 commit、文件清单、许可、归属或清理要求不清楚。
- 需要读取、提交或公开密钥、token、cookie、私钥、真实 dynamic parameters/receipts、真实企业数据、可识别企业关系或本机秘密路径。
- 需要使用真实外部服务、长期凭据或受控数据，但 Issue 没有明确授权、最小权限和脱敏证据要求。

不要把仓库中的 `.env`、受控回执或本地研究制品当作可提交证据。示例与测试只能使用公开、合成或明显假值；受控验证只记录摘要、保管位置和结论。

## 本地构建、测试与验证

以下命令来自当前 `README.md`、`deno.json`、合约说明和 `web/package.json`；根据改动范围选择并保存结果：

- 安装/准备：当前尚未定义仓库级 install task；`README.md` 只说明 Deno 安装方法。不得因方便而提交本机配置或凭据。
- 格式化/静态检查：当前尚未定义独立的 format/lint task；`deno.json` 只声明了 `fmt` 与 `lint` 的文件范围。
- 根测试：`deno task test`
- Myfish/WASM 合约构建：`deno task contracts:build`
- 确定性合约测试：`deno task contracts:test`
- EVM 合约测试：`deno task contracts:evm:test`
- Web 构建：`deno task build`
- Web Sites 测试：`pnpm --dir web test:sites`
- 真实 TCS 联调：仅在 Issue 明确授权且凭据位于仓库外的受控环境时，使用 `README.md` 记录的 `RUN_TCS_INTEGRATION=true ...` 命令；不得把结果数据或凭据提交到仓库。
- 安全/数据自动检查：当前尚未定义专用任务或 CI 工作流。提交前必须人工核对 diff、文件范围、示例数据分类和生成制品，确保没有秘密或真实企业数据。

文档改动至少执行链接可访问性检查、`git diff --check`、变更范围检查和敏感内容人工复核。代码、合约或前端改动应执行与范围相称的上述测试/构建；若因环境或受控服务无法执行，必须如实记录，不得声称通过。

## 任务与提交边界

- 一个实现 Issue 只对应本仓库的一个任务、worktree、分支和 PR。
- 跨仓父 Issue 只协调范围、依赖和验收，不能在本仓代替其他仓库实现。
- PR 正文必须引用并关闭本仓实现 Issue；跨仓引用使用完整 `owner/repository#number`。
- 迁移任务必须在 Issue 中固定来源 commit 和文件清单，不把一次迁移清单写成本仓库永久架构事实。
- 提交前确认 diff 只包含 Issue 授权的文件；不得顺带修改业务代码、依赖、构建配置、数据或制品。
