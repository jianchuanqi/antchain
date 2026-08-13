# Antchain

## Deno Install

```bash
curl -fsSL https://deno.land/x/install/install.sh | sh
```

## Antchain Example

```bash
deno run -A src/examples/blockchain-data-example.ts
```

## TCS Privacy Computing

The privacy-computing workflow uses the TCS platform APIs, not the legacy
blockchain `/privacy/task` path. Configure `.env` with `ISV_APIAUTH_AK` and
`ISV_APIAUTH_SK`; optional overrides are `TCS_REST_URL`, `TCS_TENANT_ID`,
`TCS_PROJECT_ID`, `TCS_ENV_ID`, and `TCS_APP_ID`.

```bash
deno task test
RUN_TCS_INTEGRATION=true deno test --allow-read --allow-net --allow-env src/core/tcs/client_test.ts --filter "TCS integration"
```

The integration test creates a real TCS app instance and waits for a successful
result dataset before sampling data.

The verified node topology, HMAC signing rules, privacy-computing run, sandbox
project payloads, application operations, IDs, and known failure modes are
recorded in
[docs/antchain-privacy-sandbox-runbook.md](docs/antchain-privacy-sandbox-runbook.md).

## Eco Design Digital Label MVP

The local MVP implements configurable weighted evaluation in a deterministic
sandbox, SHA-256 commitments, label issuance/revocation, role-filtered Hono
APIs, and a public QR verification landing page. It defaults to an in-memory
ledger and local sandbox so tests do not require external TCS or AntChain
services. See [the architecture and API guide](docs/eco-label-mvp.md).

```bash
deno test --allow-read --allow-net --allow-env src/eco/eco_label_test.ts
```

## Contract Example

```bash
deno run -A src/examples/contract-example.ts
```

For more details about writing and deploying contracts, please visit project
[myfish-contract](https://github.com/Biaoo/myfish-contract)

## Eco-label contract suite

`contracts/eco-label/` now uses one primary Myfish/AssemblyScript WASM contract,
`R2026001EDDLEcoLabelRegistryUnifiedV2`. Rule governance and label lifecycle
share one storage boundary, so issuance checks the active rule atomically.
The previous two-contract CompatV2 implementation remains available only for
historical evidence and regression. The suite includes
compiler-generated ABI/WASC artifacts, a frozen conformance oracle, a
deterministic in-memory simulator, strict final-receipt mapping tests, and an
accuracy-report generator.

The unified Myfish V2 contract is deployed on the research chain. Deployment,
initialization, rule registration, activation, and one synthetic label issue
are included in blocks 15347301–15347307; the label/task read-backs match and a
later-block recheck passed. The recorded assurance is
`RESEARCH_STATE_CONFIRMED` because the gateway still returns
`txFinish=false/txSuccess=false`. Historical CompatV2 evidence remains
read-only; new deployments use the unified contract and create no rule mirror.

```bash
./contracts/eco-label/build-contracts.sh
npx --yes deno test --allow-read --allow-net --allow-env \
  src/eco/contracts/contract_suite_test.ts \
  src/eco/adapters/antchain_test.ts
```

See
[the contract interface and deployment gates](contracts/eco-label/interface.md),
[the Chinese contract guide](contracts/eco-label/README.md), and
[the accuracy report](docs/eco-label-contract-accuracy-report.md).

## Start Server

```bash
deno run -A src/server.ts
```

## Web frontend

The dashboard is a Vite application in `web/`. Build it with `deno task web` (or
`deno task build`); run its independent Sites checks with
`pnpm --dir web test:sites`.
