# EcoDesignLabelRegistryV1 — EVM/Solidity release candidate

This directory is the migration target for the eco-design digital identifier
smart-contract deliverable. It replaces the two-contract Myfish research path
with one atomic EVM contract while preserving the earlier WASM evidence under
`contracts/eco-label/`.

The single deployed contract contains two logical modules:

- algorithm governance: register, activate, suspend and retire a versioned rule
  and evaluator commitment;
- label lifecycle: atomically require the active rule, issue a unique
  label/task, suspend, resume, revoke, expire and query it. Version replacement
  is recoverable in two idempotent transactions: issue the new label, then link
  the old label to the new label with `supersedeLabel`.

The contract stores commitments only. It has no score, grade, indicator, BOM,
supplier or evidence-content field.

## Reproducible local build and execution

```bash
npx --yes deno task contracts:evm:build
npx --yes deno task contracts:evm:test
```

Pinned platform build settings:

- AntChain-modified Solidity compiler
  `0.4.24+commit.6eda33a0.mod.Emscripten.clang`;
- source declaration `pragma solidity ^0.4.0`;
- platform `identity` account type rather than native Solidity `address`;
- optimizer enabled.

The build command downloads the official `alipay-solc-0.4.24` distribution,
verifies its fixed `soljson.js` SHA-256, and compiles the deployment artifact
with that compiler. A separate native 0.4.23 reference is used only for local
semantic execution; it is not a platform deployment artifact.

Artifacts are written to `dist/`:

- `EcoDesignLabelRegistryV1.json`: full reproducible artifact;
- `EcoDesignLabelRegistryV1.abi.json`: platform ABI;
- `EcoDesignLabelRegistryV1.bin`: constructor bytecode.
- `antchain-evm-deployment-package.v1.json`: platform import settings, artifact
  commitments and the explicit runtime boundary.

The constructor has no arguments. The platform deployment account is assigned
the admin, algorithm-admin, label-issuer and lifecycle roles through
`msg.sender`. A production operator can grant separate accounts and then remove
operational roles from the deployment account.

## AntChain platform deployment boundary

Create one EVM/Solidity contract project in the management platform, compile
with the pinned settings, and compare source, ABI and bytecode digests with the
local artifact before deployment. The recommended deployed contract name is
`EcoDesignLabelRegistryV1`.

Do not upload the earlier native Solidity draft. Upload the source in this
directory and select the platform's 0.4.x Solidity compiler with optimization
enabled. The constructor has no arguments. AntChain timestamps are
milliseconds; any non-zero `expiresAt` passed to the contract must use that
unit.

After deployment, record the platform project name, chain name, contract ID,
deployment transaction, block, source/ABI/bytecode digests and assigned roles.
Do not configure the EDDL service to use the new contract until these values and
the event/query behavior have been independently checked. Earlier Myfish/WASM
contract IDs are research history and are not aliases for this EVM contract.

The currently pinned `@antchain/jssdk@1.2.1` KMS-managed REST provider supports
Solidity deployment but explicitly rejects Solidity `callContract`. Therefore
the platform deployment package is ready, while automatic service cutover
remains disabled until AntChain supplies and verifies either a managed EVM call
API or an approved account-signing path. Check this boundary with:

```bash
npx --yes deno task contracts:evm:preflight
```
