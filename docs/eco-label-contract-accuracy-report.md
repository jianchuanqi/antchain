# 生态设计数字标识智能合约算法准确率报告

- 套件：`eco-design-label-contract-suite/v1`
- 冻结 Oracle：`2026-08-11` / `sha256:3d0eee27022bc209fd41d6d4abed4153e70555294c746aafec98a9e4970ac0b8`
- 场景执行一致率：**100%**（37/37，门槛 95%）
- 关键安全不变量：**100%**（26/26，目标 100%）
- 结论：通过

> 本报告衡量冻结业务场景与确定性合约规则模拟器执行结果的一致性，不代表生态设计评级的科学准确性，也不构成已部署 WASM 或真实链执行证明。目标链部署后必须用同一 Oracle 重跑并归档终局回执、事件和独立读回。

## 真实研究链补充证据（不计入准确率）

2026-08-13 的统一 V2 合约已经在目标链完成部署、初始化、规则登记、规则激活和一个
合成标识签发。合约 Identity 为
`9c8bcf8b09c81d225b3e349f51a7db401673d2f8f33c137e7ba77405af2d68be`，链上 WASC
摘要为 `7bc97057da980bffa1fe70c700e9a10a881cb6253428acc6052b1aba6549bf01`。
标识 `EDDL-RESEARCH-2026-001-UNIFIED-001` 位于区块15347307，按 labelId 和 taskId
查询一致且为 `ACTIVE`；区块15347308再次复核规则和标识状态未变化。

目标网关仍对这些已入块、执行结果为0且可读回的交易返回
`txFinish=false/txSuccess=false`，因此状态为 `RESEARCH_STATE_CONFIRMED`，不是标准
终局回执确认。这个单一正向样例不进入本报告37/37或26/26的分子、分母，也不能替代
全部冻结场景的真实链重跑。

2026-08-12 的 CompatV2 试验已在目标链独立读回一个合成标识：来源规则状态锚定于
区块15318726，镜像同步状态位于区块15318740，签发状态位于区块15318756；按
labelId 和 taskId 查询一致且为 `ACTIVE`，签发前后规则注册表读回一致。对应冻结
EcoLabelRegistry WASC 摘要为
`f047bc028aac1a43bc8a22192010b8d1ce8d76dc4af63d34bae3a24b636a3c15`，ABI 摘要为
`d5e6ba30380d5f98111664172a854bba25762d7cbd1c8cb3c333775a9558f4be`。

目标网关仍对这些已入块、可读回状态返回 `txFinish=false/txSuccess=false`，因此证据
closure 为 `INCOMPLETE_TRANSACTION_EVIDENCE`，没有 `completedAt`。这个单一正向
样例只证明 CompatV2 的真实链部署、有限期规则镜像、签发状态和双读路径可运行；它
不是37项冻结场景的真实链重跑，不进入本报告37/37或26/26的分子、分母，也不能作为
终局回执验收通过的证明。

CompatV2 的规则镜像是非原子兼容方式，TTL 最长24小时。在来源规则暂停或换版后、
同步器更新镜像或镜像到期前可能存在陈旧窗口；这一风险由镜像角色分离、缩短 TTL、
状态监控和签发前后双读控制，但不能等同于链上跨合约原子核验。

| 场景 | 操作 | 预期 | 实际 | 结果 | 安全不变量 |
| --- | --- | --- | --- | --- | --- |
| ALG-001 | unauthorized-register | ERROR/UNAUTHORIZED | ERROR/UNAUTHORIZED | PASS | 是 |
| ALG-002 | register | SUCCESS | SUCCESS | PASS | 否 |
| ALG-003 | idempotent-register | SUCCESS | SUCCESS | PASS | 否 |
| ALG-004 | register-conflict | ERROR/IDEMPOTENCY_CONFLICT | ERROR/IDEMPOTENCY_CONFLICT | PASS | 是 |
| ALG-005 | unauthorized-status | ERROR/UNAUTHORIZED | ERROR/UNAUTHORIZED | PASS | 是 |
| ALG-006 | activate | SUCCESS | SUCCESS | PASS | 否 |
| ALG-007 | single-active-version | ERROR/ACTIVE_VERSION_CONFLICT | ERROR/ACTIVE_VERSION_CONFLICT | PASS | 是 |
| ALG-008 | replace-active-version | SUCCESS | SUCCESS | PASS | 否 |
| ALG-009 | retired-is-terminal | ERROR/TERMINAL_STATE | ERROR/TERMINAL_STATE | PASS | 是 |
| ALG-010 | revoked-role-cannot-register | ERROR/UNAUTHORIZED | ERROR/UNAUTHORIZED | PASS | 是 |
| ALG-011 | signed-bundle-release-binding | SUCCESS | SUCCESS | PASS | 是 |
| MIR-001 | unauthorized-mirror-sync | ERROR/UNAUTHORIZED | ERROR/UNAUTHORIZED | PASS | 是 |
| MIR-002 | mirror-active-state | SUCCESS | SUCCESS | PASS | 是 |
| MIR-003 | mirror-stale-source-block | ERROR/STALE_SOURCE_STATE | ERROR/STALE_SOURCE_STATE | PASS | 是 |
| MIR-004 | mirror-same-block-conflict | ERROR/IDEMPOTENCY_CONFLICT | ERROR/IDEMPOTENCY_CONFLICT | PASS | 是 |
| MIR-005 | mirror-metadata-conflict | ERROR/MIRROR_METADATA_CONFLICT | ERROR/MIRROR_METADATA_CONFLICT | PASS | 是 |
| MIR-006 | single-active-mirror | ERROR/ACTIVE_VERSION_CONFLICT | ERROR/ACTIVE_VERSION_CONFLICT | PASS | 是 |
| MIR-007 | expired-mirror-blocks-issue | ERROR/ALGORITHM_NOT_ACTIVE | ERROR/ALGORITHM_NOT_ACTIVE | PASS | 是 |
| LBL-001 | unauthorized-issue | ERROR/UNAUTHORIZED | ERROR/UNAUTHORIZED | PASS | 是 |
| LBL-002 | inactive-algorithm | ERROR/ALGORITHM_NOT_ACTIVE | ERROR/ALGORITHM_NOT_ACTIVE | PASS | 是 |
| LBL-003 | invalid-commitment | ERROR/INVALID_COMMITMENT | ERROR/INVALID_COMMITMENT | PASS | 是 |
| LBL-004 | issue | SUCCESS | SUCCESS | PASS | 否 |
| LBL-005 | invalid-expiry | ERROR/INVALID_EXPIRY | ERROR/INVALID_EXPIRY | PASS | 否 |
| LBL-006 | idempotent-issue | SUCCESS | SUCCESS | PASS | 否 |
| LBL-007 | label-payload-conflict | ERROR/IDEMPOTENCY_CONFLICT | ERROR/IDEMPOTENCY_CONFLICT | PASS | 是 |
| LBL-008 | task-double-use | ERROR/IDEMPOTENCY_CONFLICT | ERROR/IDEMPOTENCY_CONFLICT | PASS | 是 |
| LBL-009 | suspend-resume | SUCCESS | SUCCESS | PASS | 否 |
| LBL-010 | unauthorized-lifecycle | ERROR/UNAUTHORIZED | ERROR/UNAUTHORIZED | PASS | 是 |
| LBL-011 | revoke-is-terminal | ERROR/INVALID_TRANSITION | ERROR/INVALID_TRANSITION | PASS | 是 |
| LBL-012 | revocation-payload-conflict | ERROR/IDEMPOTENCY_CONFLICT | ERROR/IDEMPOTENCY_CONFLICT | PASS | 是 |
| LBL-013 | expire-too-early | ERROR/NOT_DUE | ERROR/NOT_DUE | PASS | 否 |
| LBL-014 | expire-when-due | SUCCESS | SUCCESS | PASS | 否 |
| LBL-015 | replace-label | SUCCESS | SUCCESS | PASS | 否 |
| LBL-016 | replace-revoked-label | ERROR/TERMINAL_STATE | ERROR/TERMINAL_STATE | PASS | 是 |
| LBL-017 | algorithm-registry-binding-readback | SUCCESS | SUCCESS | PASS | 是 |
| SEC-001 | minimal-state-fields | SUCCESS | SUCCESS | PASS | 是 |
| SEC-002 | minimal-event-fields | SUCCESS | SUCCESS | PASS | 是 |

复现命令：

```bash
npx --yes deno run --allow-read \
  src/examples/generate-eco-contract-accuracy-report.ts
```
