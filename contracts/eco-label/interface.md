# 智能合约接口与验收规范

## 1. 共同约束

- 编译路线：AntChain Myfish 1.2.1、MyAssembly 1.2.0、AssemblyScript、WASM。
- 标识符只允许字母、数字、`. _ : -`，长度不超过128；版本不超过64。
- 承诺统一为 `sha256:` 加64位小写十六进制字符。
- 角色账户和固定合约身份为64位小写十六进制蚂蚁链 Identity。
- 链上及事件中不得出现 BOM、供应商明细、指标值、分数、等级、证据文件或个人信息。
- AlgorithmRegistry 的 scheme 固定为 `eco-design-digital-identifier`；可信数据空间
  授权用途 `eco-design-labelling` 是另一字段，不得混用。
- `algorithmHash` 必须取 EDDL 签名模板包的 `bundleDigest`；`evaluatorHash`
  必须取同一模板包声明的评价器不可变工件摘要。
- 写操作可能返回 JSON，但网关首次受理仍然只是
  `PENDING`；只有终局回执、执行成功、合约、方法、事件和 payload
  摘要全部匹配才能成为 `CONFIRMED`。

## 2. 当前主合约：UnifiedRegistry

`R2026001EDDLEcoLabelRegistryUnifiedV2` 在同一 Myfish 合约内保存规则版本和标识
生命周期。`issueLabel` 读取同一存储边界中的规则记录和 scheme 当前活动版本，因此
规则状态核验与签发是同一交易内的原子条件。

角色：`DEFAULT_ADMIN`、`ALGORITHM_ADMIN`、`LABEL_ISSUER`、
`LABEL_LIFECYCLE_ADMIN`。`initialize()` 仅执行一次并将这些角色授予部署调用者。

主要方法：

- 规则：`registerAlgorithm`、`setAlgorithmStatus`、`replaceActiveAlgorithm`、
  `getAlgorithm`、`getActiveAlgorithmId`、`isAlgorithmActive`；
- 标识：`issueLabel`、`suspendLabel`、`resumeLabel`、`revokeLabel`、
  `expireLabel`、`replaceLabel`、`getLabel`、`getLabelByTaskId`；
- 权限：`grantRole`、`revokeRole`、`hasRole`。

签发记录只包含标识符、规则标识及六项 SHA-256 承诺、签发者、时间和状态；不接受
分数、等级、BOM、供应商数据和原始证据。labelId/taskId 双唯一；相同完整请求返回
原记录，不同内容复用任一标识符均拒绝。

冻结工件：WASC
`7bc97057da980bffa1fe70c700e9a10a881cb6253428acc6052b1aba6549bf01`，ABI
`cc2e64380e78810cc14fe4802ad072b2e58302529fdeb0f9c7af1102e4ca1d3b`。

## 3. 历史双合约：AlgorithmRegistry

角色：`DEFAULT_ADMIN` 管理角色，`ALGORITHM_ADMIN` 登记和管理规则版本。首次
`initialize()` 将两个角色授予部署调用者，且只能执行一次。

| 方法签名                                                 | 约束与结果                                                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize()`                                           | 一次性初始化。                                                                                                                                                           |
| `grantRole(string,string)` / `revokeRole(string,string)` | 仅 `DEFAULT_ADMIN`；角色变更有审计事件。                                                                                                                                 |
| `hasRole(string,string)`                                 | 查询角色。                                                                                                                                                               |
| `registerAlgorithm(string,string,string,string,string)`  | 参数依次为 algorithmId、schemeId、version、algorithmHash、evaluatorHash；初始 `DRAFT`。相同完整 payload 重试返回原记录，不同 payload 复用 ID 报 `IDEMPOTENCY_CONFLICT`。 |
| `setAlgorithmStatus(string,string)`                      | 状态为 `DRAFT/ACTIVE/SUSPENDED/RETIRED`；`RETIRED` 终局；每个 scheme 同时最多一个 `ACTIVE`。                                                                             |
| `replaceActiveAlgorithm(string,string)`                  | 原子暂停当前版本并启用同 scheme 的新版本。                                                                                                                               |
| `getAlgorithm(string)`                                   | 返回公开元数据和承诺的 JSON。                                                                                                                                            |
| `getActiveAlgorithmId(string)`                           | 返回 scheme 当前启用版本。                                                                                                                                               |
| `isAlgorithmActive(string,string)`                       | 供外部协调器独立核验规则 ID 与摘要是否活动；返回字符串 `"1"` 或 `"0"`。目标研究链当前不能由 EcoLabelRegistry 可靠地跨合约调用该方法。                                  |

事件：`RoleGranted`、`RoleRevoked`、`AlgorithmRegistered`、`AlgorithmStatusChanged`、`AlgorithmReplaced`。

## 4. 历史双合约：EcoLabelRegistry / CompatV2

角色：`DEFAULT_ADMIN`、`ALGORITHM_MIRROR_ADMIN`、`LABEL_ISSUER`、
`LABEL_LIFECYCLE_ADMIN`。首次
`initialize(algorithmRegistryContractId)`
将四个角色授予部署调用者，并固定不可由浏览器覆盖的 AlgorithmRegistry 合约身份。

| 方法签名                                                                                                    | 约束与结果                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize(string)`                                                                                        | 一次性初始化和固定规则注册表身份。                                                                                                                                                                                                                                |
| `grantRole(string,string)` / `revokeRole(string,string)`                                                    | 仅 `DEFAULT_ADMIN`；角色变更有审计事件。                                                                                                                                                                                                                          |
| `getAlgorithmRegistryContractId()`                                                                          | 读回初始化时固定且不可修改的 AlgorithmRegistry 合约身份；外部验证者必须与受信发布清单中的身份比对。                                                                                                                                                               |
| `syncAlgorithmState(string,string,string,string,string,string,string,uint64,uint64)`                         | 仅 `ALGORITHM_MIRROR_ADMIN`。写入 algorithmId、schemeId、version、规则/评价器摘要、状态、完整来源快照摘要、来源区块高度和 `validUntil`。来源区块只能前进；同区块同 payload 幂等，同区块不同 payload 冲突；`ACTIVE` 镜像必须尚未过期。                 |
| `getAlgorithmStateMirror(string)`                                                                            | 返回规则镜像、来源状态摘要、高度、有效期、同步者和更新时间。                                                                                                                                                                                                      |
| `getActiveMirroredAlgorithmId(string)` / `isMirroredAlgorithmActive(string,string)`                         | 查询 scheme 的镜像活动算法，并同时核验规则摘要、活动映射和镜像有效期。                                                                                                                                                                                            |
| `issueLabel(string,string,string,string,string,string,string,string,string,uint64)`                         | labelId、taskId、algorithmId、algorithmHash、inputHash、resultHash、evidenceHash、authorizationHash、proofHash、expiresAt。要求对应镜像仍为 `ACTIVE` 且未过期、五项业务承诺有效、label/task 双唯一；逐字段幂等，不同 payload 冲突。                 |
| `suspendLabel(string)` / `resumeLabel(string)`                                                              | 生命周期管理员暂停或恢复；已到期、撤销、换版的标识不能恢复。                                                                                                                                                                                                      |
| `revokeLabel(string,string)`                                                                                | 生命周期管理员撤销并保存原因摘要；撤销终局，同原因重试幂等。                                                                                                                                                                                                      |
| `expireLabel(string)`                                                                                       | 到达链上区块时间后任何调用者可推进为 `EXPIRED`。                                                                                                                                                                                                                  |
| `replaceLabel(string,string,string,string,string,string,string,string,string,string,uint64)`                | 原子签发新标识并将旧标识置为 `SUPERSEDED`，保留双向换版引用；新标识仍须通过活动镜像校验。                                                                                                                                                                         |
| `getLabel(string)` / `getLabelByTaskId(string)`                                                             | 按标识或任务查询最小链上记录；记录包含本次签发所使用的 `algorithmSourceStateHash` 和 `algorithmSourceBlockHeight`。                                                                                                                                                |

状态：`ACTIVE → SUSPENDED → ACTIVE`；`ACTIVE/SUSPENDED → REVOKED/EXPIRED/SUPERSEDED`，后三者均为终局。

事件：`RoleGranted`、`RoleRevoked`、`AlgorithmStateMirrored`、`LabelIssued`、
`LabelStatusChanged`、`LabelRevoked`、`LabelSuperseded`。

### 4.1 目标链兼容模式

目标研究链上的 Myfish `BaseContract.callContract` 调用无法可靠进入
AlgorithmRegistry，因此 CompatV2 不把镜像描述为“链上跨合约证明”。协调器必须：

1. 固定 AlgorithmRegistry 身份和链上 WASC 摘要；
2. 在同一稳定区块窗口内读取完整算法记录、活动算法 ID 和活动判定，并将来源区块
   高度、哈希、时间、时间单位一并纳入 `sourceStateHash`；
3. 先持久化不可变同步意图，再由 `ALGORITHM_MIRROR_ADMIN` 写入镜像；
4. 独立读回镜像，签发前后再次读取 AlgorithmRegistry；
5. 将镜像有效期视为最大陈旧窗口，而不是规则永远有效的证明。

当前研究 runner 采用最长24小时 TTL。AlgorithmRegistry 在镜像有效期内发生暂停、
换版或退役时，EcoLabelRegistry 不会自动获知；同步器必须立即写入新状态。要求链上
原子核验的生产部署仍需修复跨合约能力，或采用另行评审的单合约结构。

## 5. 适配器终局映射

`AntChainLedgerAdapter` 首次提交固定 orderId
并持有以下非敏感核验上下文：合约名、方法签名、期望事件和 payload 摘要。默认
mapper 只接受如下已规范化的成功回执：

真实适配器在提交签发或换版之前，还要求调用方明确给出 `VERIFIED_DATA_USE_GRANT`
和 `VERIFIED_TCS` 两项保证。旧 MVP
生成的自声明授权摘要和本地确定性沙箱只能进入内存演示账本，不能进入蚂蚁链适配器。

```json
{
  "finality": "FINAL",
  "executionStatus": "SUCCESS",
  "transactionHash": "<64 hex>",
  "blockHeight": 123,
  "finalizedAt": "2026-08-11T08:00:00.000Z",
  "contractName": "<fixed contract>",
  "methodSignature": "<fixed ABI signature>",
  "eventName": "<expected event>",
  "inputValues": ["<decoded canonical input>"]
}
```

HTTP成功、`success: true`、orderId、请求哈希、交易哈希或未知回执结构都不会自行成为
`CONFIRMED`。真实网关的回执和事件结构必须由部署方编写
normalizer，并用保存的真实正反回执测试。适配器会用回执中的合约、方法和
`inputValues` 重新计算 payload 摘要，再与提交前持久化的摘要比对；不能由
normalizer 自报一个未经核算的摘要。

## 6. 生产部署门槛

当前源码和本地 `.wasc/.abi` 已真实编译；统一 V2 已形成可独立读回的真实研究链
标识状态，但供应商标准终局字段仍未闭合，因此仍不构成生产验收。上线前必须完成：

1. 确认目标蚂蚁链版本支持 Myfish 1.2.x ABI 和 `uint64` 网关签名编码；当前主路径只用
   单一统一合约，历史镜像兼容模式不得用于新签发。
2. 实测 `getBlockTimeStamp()` 的单位，并固定
   `ECO_ANTCHAIN_BLOCK_TIMESTAMP_UNIT=seconds|milliseconds`；未确认时适配器拒绝签发带到期时间的标识。
3. 用真实回执固定 raw receipt/event normalizer，测试
   pending、revert、事件错配、合约错配和摘要错配。
4. 从统一合约独立读回链上代码摘要、活动算法 ID、算法摘要和标识双路状态，确认规则
   核验与签发位于同一合约存储和同一交易边界。
5. 通过多组织或多签治理分离默认管理员、规则管理员、签发者和生命周期管理员，完成
   未授权调用回滚测试。
6. 保存部署交易哈希、区块高度、合约名称/Identity、ABI/WASC摘要和独立链上查询证据。
7. 使用 eddl-platform 的统一合约适配器执行签发前规则读回、签发交易、label/task 双读
   和后续区块复核；不得回退到历史 CompatV2 镜像适配器。

仓库中的 `contracts:preflight-live` 和 `contracts:run-live` 实现上述研究链检查与
恢复流程。当前旧网关的原始回执必须同时给出 `txFinish=true` 和
`txSuccess=true`；仓库中历史 `data/receiptResult.json` 的两个字段均为 false，
因此它只能作为“不得确认”的反例，不能作为既有上链证明。

## 7. 真实链证据与准确率口径

当前统一 V2 合约的真实研究链证据为：

- Identity：`9c8bcf8b09c81d225b3e349f51a7db401673d2f8f33c137e7ba77405af2d68be`；
- WASC：`7bc97057da980bffa1fe70c700e9a10a881cb6253428acc6052b1aba6549bf01`；
- 部署至规则激活位于区块 15347301–15347305；
- 标识 `EDDL-RESEARCH-2026-001-UNIFIED-001` 签发位于区块 15347307，
  labelId/taskId 双读一致，区块 15347308 再次复核一致；
- 网关 `txFinish=false/txSuccess=false` 原样保留，状态为
  `RESEARCH_STATE_CONFIRMED`，不是标准终局回执确认。

以下 CompatV2 内容只用于历史复查：

CompatV2 使用的冻结工件摘要为：

- AlgorithmRegistry WASC：
  `3294479b2666de136529703f8f8d56ca88b474b7ea1907ad849a81b4af930f71`；
- AlgorithmRegistry ABI：
  `298bfa9d064f79071d99448446e1d57a94cdd8572409ba6867352d8a1d1c0edf`；
- EcoLabelRegistry WASC：
  `f047bc028aac1a43bc8a22192010b8d1ce8d76dc4af63d34bae3a24b636a3c15`；
- EcoLabelRegistry ABI：
  `d5e6ba30380d5f98111664172a854bba25762d7cbd1c8cb3c333775a9558f4be`。

真实研究链已读回来源规则区块15318726、镜像同步区块15318740，以及区块15318756
中的合成标识状态；按 labelId 和 taskId 查询一致且为 `ACTIVE`，规则注册表在签发前后
双读一致。由于网关仍对已入块状态返回 `txFinish=false/txSuccess=false`，当前 closure
是 `INCOMPLETE_TRANSACTION_EVIDENCE`，没有 `completedAt`，不得写成终局交易验收通过。

自动化准确率仍按冻结场景模拟器计算：37/37 场景一致率100%，其中26/26关键安全场景
一致率100%。CompatV2 的一个真实合成正向样例只证明目标链的部署、镜像、签发状态和
独立读回可运行，不等于37项场景已在真实链执行，也不评价生态设计评级的科学有效性。
