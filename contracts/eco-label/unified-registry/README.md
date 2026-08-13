# 统一生态设计数字标识合约

正式迁移目标为一个 Myfish/WASM 合约：
`R2026001EDDLEcoLabelRegistryUnifiedV2`。

规则版本治理和标识生命周期位于同一合约、同一存储边界。签发时
`issueLabel` 直接核验指定规则是否为当前 `ACTIVE` 版本，不依赖跨合约调用，
也不使用短期规则镜像。评分和等级不写入链上；链上只保存标识符、规则版本及
输入、结果、证据、授权和执行证明的 SHA-256 承诺。

## 冻结构建

- 源码：`assembly/index.ts`
- 部署工件：`dist/index.wasc`
- ABI：`dist/index.abi`
- MyAssembly：1.2.0
- 合约名称：`R2026001EDDLEcoLabelRegistryUnifiedV2`
- 已部署 Identity：`9c8bcf8b09c81d225b3e349f51a7db401673d2f8f33c137e7ba77405af2d68be`
- WASC SHA-256：`7bc97057da980bffa1fe70c700e9a10a881cb6253428acc6052b1aba6549bf01`
- ABI SHA-256：`cc2e64380e78810cc14fe4802ad072b2e58302529fdeb0f9c7af1102e4ca1d3b`

不可变归档位于
`releases/unified-myfish-v1-20260813-r3/`。该 Identity 已由部署交易、链上代码查询和
后续业务交易目标核对。

真实研究链已完成规则 `ECO-IND-FINAL-20260729@1.0.0` 激活和标识
`EDDL-RESEARCH-2026-001-UNIFIED-001` 签发；签发位于区块 15347307，后续在区块
15347308 复核规则及 labelId/taskId 双读一致。

## 验证和研究链运行

```bash
npx --yes deno task contracts:build
npx --yes deno task contracts:test

export ECO_ANTCHAIN_CONTRACT_PROFILE=unified-myfish-v1
npx --yes deno task contracts:preflight-live

export RUN_ANTCHAIN_ECO_LABEL_LIVE=true
npx --yes deno task contracts:run-unified-live
```

运行器在每次外部写入前持久化不可变意图和稳定 `orderId`。已发送但结果未知的
请求只允许查询，不会重新提交。研究链只有同时满足固定区块、正确目标合约、链上
代码摘要、规则 `ACTIVE`、labelId/taskId 双路读回以及后续区块复查，才记录
`RESEARCH_STATE_CONFIRMED`；它不会改写供应商返回的 `txFinish/txSuccess`。
