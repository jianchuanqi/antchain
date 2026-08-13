# 生态设计数字标识智能合约算法套件

本目录提供可编译的蚂蚁链 Myfish/AssemblyScript WASM 合约。当前正式迁移目标是
`unified-registry/`：规则版本治理与标识生命周期在一个合约内完成，签发时原子核验
规则状态，不依赖目标链已证明不兼容的跨合约调用。旧双合约和 CompatV2 仅保留作
历史证据与回归对照。

## 内容

- `unified-registry/`：当前主合约，含规则治理、签发门槛和标识生命周期。
- `algorithm-registry/`：历史双合约的 `AlgorithmRegistry` 源码、Myfish 配置、生成的 ABI 和
  `.wasc` 部署包。
- `eco-label-registry/`：`EcoLabelRegistry` 源码、Myfish 配置、生成的 ABI 和
  `.wasc` 部署包。
- `conformance/scenarios.json`：冻结的自动化场景与预期 Oracle。
- `releases/eddl-chain-algorithm-release.v1.json`：由 EDDL 签名模板包生成并供链上
  登记使用的机读发布清单。
- `releases/target-chain-compat-v2/`：目标研究链兼容版本的冻结源码、ABI、WASC
  和摘要清单；该版本使用受治理的短时规则镜像，不依赖目标链当前不可用的 Myfish
  跨合约调用。
- `interface.md`：接口、状态、事件、链上最小字段和部署门槛。
- `build-contracts.sh`：使用固定的 Myfish CLI 1.2.1 和仓库中的 MyAssembly 1.2.0
  重建两份合约。
- `deploy-contracts.sh`：显式、分阶段的部署入口；不会在缺少凭据时运行，也不会把网关受理误报为部署成功。

## 构建与验证

```bash
./contracts/eco-label/build-contracts.sh
npx --yes deno test --allow-read --allow-net --allow-env \
  src/eco/contracts/contract_suite_test.ts \
  src/eco/adapters/antchain_test.ts
npx --yes deno run --allow-read \
  src/examples/generate-eco-contract-accuracy-report.ts
```

构建输出中的 `index.wasc` 是 Myfish 部署使用的包；`index.abi` 是编译器生成的
ABI。`index.wasm` 和 `index.wat` 仅为本地诊断产物，继续保持忽略。

当前统一合约冻结构建（2026-08-13）摘要：

| 工件                           | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| UnifiedRegistry `index.wasc` | `7bc97057da980bffa1fe70c700e9a10a881cb6253428acc6052b1aba6549bf01` |
| UnifiedRegistry `index.abi`  | `cc2e64380e78810cc14fe4802ad072b2e58302529fdeb0f9c7af1102e4ca1d3b` |

这些摘要已与目标链上的 UnifiedV2 代码读回一致；它们本身仍不替代交易和区块证据。
准确率报告当前运行的是与合约源码保持同一规则的确定性模拟器：37/37
场景一致、26/26 关键安全场景一致。UnifiedV2 的真实链试验覆盖一个合成标识的
正向签发和独立读回，不进入上述准确率分子或分母；形成最终第三方评价证据仍需在
目标链用同一冻结 Oracle 重跑全部场景，并保存可接受的终局回执、事件和独立读回。

链上规则登记不再维护一套独立手写摘要。当前 EDDL 机读发布清单的文件摘要为
`sha256:2e73fffbd2edeeef69843c73a4ed44bd6716a218ded9a69df706c00a0f1fee48`，其中：

- `algorithmId=ECO-IND-FINAL-20260729`；
- `schemeId=eco-design-digital-identifier`；数据授权用途仍是不同字段
  `eco-design-labelling`；
- `algorithmHash=sha256:825eed2a806a4fd3b40509594c73df2d0f53909483c017edbea5a1aa323c86e3`，
  对应签名模板包的 `bundleDigest`；
- `evaluatorHash=sha256:5583d1e886d390e799af6d45a7fc0c2a49615002a4d5c5c1032c38d6c8c21938`，
  对应模板包内评价器 `artifactDigest`，当前仍为 `UNPUBLISHED` 构建上下文承诺。

预检默认读取仓库内冻结副本，也可通过绝对路径
`EDDL_CHAIN_ALGORITHM_RELEASE_FILE` 直接读取 EDDL 生成文件，并可用
`EDDL_CHAIN_ALGORITHM_RELEASE_DIGEST` 固定文件摘要。`ECO_ALGORITHM_ID`、
`ECO_SCHEME_ID`、`ECO_ALGORITHM_VERSION`、`ECO_ALGORITHM_HASH` 或
`ECO_EVALUATOR_HASH` 与清单不一致时，预检拒绝真实写链。

## 当前统一合约部署顺序

1. 配置
   `ANTCHAIN_REST_URL`、`ANTCHAIN_BIZ_ID`、`ANTCHAIN_ACCESS_ID`、
   `ANTCHAIN_ACCESS_SECRET_FILE` 和 `ANTCHAIN_ACCOUNT`。当前 KMS 托管模式还需
   `ANTCHAIN_TENANT_ID` 与 `ANTCHAIN_KMS_ID`，不需要账户私钥；仅本地密钥模式才使用
   `ANTCHAIN_ACCOUNT_PRIVATE_KEY_FILE`。所有密钥只通过受限文件提供，不把内容写入仓库。
2. 设置 `ECO_ANTCHAIN_CONTRACT_PROFILE=unified-myfish-v1`，执行只读预检。
3. 运行 `contracts:run-unified-live`。它部署唯一合约，调用一次 `initialize()`，
   登记并启用冻结规则，再签发一个不含评分明细的合成标识。
4. 按交易哈希确认固定区块和目标 Identity，通过 `QUERYCONTRACT` 核对 WASC，
   再用 `getAlgorithm`、`getActiveAlgorithmId`、`isAlgorithmActive`、`getLabel`
   和 `getLabelByTaskId` 独立读回。
5. 后续区块再次核对原区块哈希、规则和标识状态，形成
   `RESEARCH_STATE_CONFIRMED`。平台配置只允许填写这次部署的新名称、Identity 和摘要。

部署脚本只提交部署请求，不声称请求已经终局。详见 `interface.md` 的生产门槛。

## 研究链一键闭环

真实网关使用 KMS 托管账户时，不需要账户私钥，但仍必须有 REST AccessKey
对应的 RSA 握手私钥。它与 KMS key id 是两种不同材料，不能互相替代。推荐只通过
绝对文件路径提供，不把私钥内容写入 `.env`：

```bash
export ANTCHAIN_ACCESS_SECRET_FILE=/absolute/path/restAkPrivate_key.key
npx --yes deno task contracts:preflight-live
```

预检会执行一次只读握手，只显示凭据“存在/缺失/有效”和认证是否成功，不会显示
access id、token 或私钥。确认输出中的
研究网关和统一合约名后，运行。任何非空 `DEBUG`、任何非空
`MYFISH_DEBUG` 或 `NODE_ENV=development` 都会被拒绝，因为上游 SDK 的调试输出
可能包含凭据、令牌和完整请求体：

```bash
export RUN_ANTCHAIN_ECO_LABEL_LIVE=true
npx --yes deno task contracts:run-live
```

该命令按顺序完成统一合约部署或受控恢复、初始化、研究规则登记和启用、合成标识
签发、链上代码、活动算法状态、`getLabel` 与 `getLabelByTaskId` 独立读回，并将脱敏
证据写入 `.codex-local/eco-label-antchain-unified-live/evidence.json`。任何 HTTP 受理、交易哈希或
`success: true` 都不算完成；标准终局要求 `txFinish=true`、`txSuccess=true`、执行码为零、
合约身份正确、事件及输入承诺一致；研究状态确认还须完成固定区块、代码、规则、双读和
后续区块复核。评价器工件当前仍
是未发布的构建上下文摘要，因此即使实链闭环成功，标识也只能标为
`RESEARCH_TRIAL`。

若进程在“意图已落盘、交易哈希尚未落盘”之间中断，脚本只在当前链上代码或完整
业务状态与冻结请求逐项一致时记录 `STATE_ALREADY_SATISFIED` 恢复证据。该记录不含
也不伪造原交易哈希；状态不能完整证明时仍然停止，且不会重提未知结果的请求。
如果链上已有状态但证据集中缺少任一必需写操作的终局交易证据，脚本只报告
`PREEXISTING_STATE_VERIFIED`、`STATE_RECOVERED_WITHOUT_TRANSACTION_EVIDENCE`
或 `INCOMPLETE_TRANSACTION_EVIDENCE`，
不写 `completedAt`，也不声称本次真实交易闭环完成。证据文件和每个请求意图还绑定
网关、bizId、tenant、account 与 KMS 的组合承诺，切换任一业务链上下文都会拒绝复用。

### 2026-08-13 统一合约真实研究链结果

当前主合约 `R2026001EDDLEcoLabelRegistryUnifiedV2` 已完成真实部署、初始化、规则登记、
规则激活和一个非敏感合成标识签发：

- 合约 Identity：`9c8bcf8b09c81d225b3e349f51a7db401673d2f8f33c137e7ba77405af2d68be`；
- 部署、初始化、登记、激活和签发分别进入区块 15347301、15347302、15347304、
  15347305 和 15347307；
- 链上 WASC 与 `sha256:7bc97057da980bffa1fe70c700e9a10a881cb6253428acc6052b1aba6549bf01` 一致；
- `ECO-IND-FINAL-20260729@1.0.0` 为当前 `ACTIVE` 规则；
- `EDDL-RESEARCH-2026-001-UNIFIED-001` 按 labelId/taskId 双读一致；
- 区块 15347308 再次复核规则和标识状态未变化。

因此研究闭环状态为 `RESEARCH_STATE_CONFIRMED`。网关原始
`txFinish=false/txSuccess=false` 保持不变，不声明标准终局回执成功。每项写操作只提交
一次，未知状态仅查询，没有重发。

### 2026-08-12 历史兼容合约结果

当前研究凭据对应的 RSA 握手、合约部署、初始化、规则登记和 `ACTIVE`
读回均已真实验证。目标网关的 `QUERYCONTRACT` 会在 WASC 前加 Myfish 类型字节
`0x02`；校验器只去除这一种明确前缀后再比对冻结 SHA-256。

V1–V5 诊断版本证明该目标链的 `BaseContract.callContract` 对
AlgorithmRegistry 调用返回 code `1`；方法名、完整方法签名以及不同 gas
配置均不能进入被调用方法。因此 CompatV2 改为
`GOVERNED_NON_ATOMIC_ALGORITHM_MIRROR`：由受权协调器独立读取规则注册表，将完整
状态和来源区块承诺以有限有效期写入 EcoLabelRegistry，再由签发合约核验镜像。

CompatV1 已完成部署、初始化和镜像同步，但将包含多个 `|` 的完整 payload
再次嵌入 `|` 分隔的标签记录，读回时字段数量不一致，导致签发交易以网关 code
`10201` 失败且没有生成标识。CompatV2 改为逐字段幂等校验并移除嵌套 payload。

CompatV2 的真实研究链状态如下：

- `R2026001EDDLEcoLabelRegistryCompatV2` 链上代码与
  `sha256:f047bc028aac1a43bc8a22192010b8d1ce8d76dc4af63d34bae3a24b636a3c15`
  一致；
- 来源规则状态锚定在区块15318726，镜像同步状态位于区块15318740；
- 合成标识 `EDDL-RESEARCH-2026-001-COMPAT-002` 的状态位于区块15318756，
  `getLabel` 与 `getLabelByTaskId` 双读一致且均为 `ACTIVE`；
- 签发前后两次 AlgorithmRegistry 读回一致，规则摘要、评价器摘要和活动状态未变；
- 网关对这些已入块且可独立读回的状态仍返回
  `txFinish=false/txSuccess=false`，证据闭合状态因此是
  `INCOMPLETE_TRANSACTION_EVIDENCE`，没有 `completedAt`。

所以可以声明“CompatV2 已形成并独立读回真实链上标识状态”，不能声明“全部写操作已
取得网关认可的终局成功回执”或“真实链37项准确率场景已经完成”。规则镜像最长有效
24小时，属于受治理的非原子兼容方式：AlgorithmRegistry 被暂停后，在同步器写入新
状态或旧镜像到期之前仍存在陈旧窗口。生产应缩短 TTL、分离镜像管理员与签发者、
监控规则变更并立即同步；若要求链上原子保证，仍需链提供方修复跨合约能力或改用经
评审的单合约方案。

当前通用 `AntChainLedgerAdapter` 只实现规则登记、状态变更和标识生命周期调用，尚未
接入上述稳定区块快照、镜像同步及签发前后双读。真实 CompatV2 闭环目前仅由受控
live runner 完成，普通 HTTP/API 业务流程不得直接指向该合约并宣称已具备同等保证。
