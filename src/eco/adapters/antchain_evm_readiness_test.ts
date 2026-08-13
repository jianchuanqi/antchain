import { assert, assertEquals } from "jsr:@std/assert@1";
import { resolveAntChainEvmReadiness } from "./antchain-evm-readiness.ts";

Deno.test("EVM preflight verifies the local platform deployment package", async () => {
  const report = await resolveAntChainEvmReadiness({
    workingDirectory: Deno.cwd(),
    environment: {},
  });
  assertEquals(report.localPackageReady, true);
  assertEquals(report.platformDeploymentConfigured, false);
  assertEquals(report.serviceRuntimeReady, false);
  assertEquals(report.platform.callPath, "MISSING");
  assert(report.blockers.some((item) => item.includes("invocation path")));
});

Deno.test("EVM preflight rejects a Myfish identity-shaped but non-hex contract id", async () => {
  const report = await resolveAntChainEvmReadiness({
    workingDirectory: Deno.cwd(),
    environment: {
      EDDL_ANTCHAIN_EVM_CONTRACT_PROJECT: "R2026001EcoDesignLabelEVM",
      EDDL_ANTCHAIN_EVM_CHAIN_NAME: "标准MYCHAIN合约链",
      EDDL_ANTCHAIN_EVM_CONTRACT_ID: "R2026001EDDLEcoLabelRegistryCompatV2",
    },
  });
  assertEquals(report.platform.contractId, "INVALID");
  assertEquals(report.platformDeploymentConfigured, false);
});

Deno.test("EVM preflight keeps an untested managed call endpoint fail-closed", async () => {
  const report = await resolveAntChainEvmReadiness({
    workingDirectory: Deno.cwd(),
    environment: {
      EDDL_ANTCHAIN_EVM_CONTRACT_PROJECT: "R2026001EcoDesignLabelEVM",
      EDDL_ANTCHAIN_EVM_CHAIN_NAME: "标准MYCHAIN合约链",
      EDDL_ANTCHAIN_EVM_CONTRACT_ID: "a".repeat(64),
      EDDL_ANTCHAIN_EVM_CALL_MODE: "managed-platform-api",
      EDDL_ANTCHAIN_EVM_CALL_ENDPOINT: "https://example.invalid/evm/call",
    },
  });
  assertEquals(report.platformDeploymentConfigured, true);
  assertEquals(report.platform.callPath, "CONFIGURED_UNVERIFIED");
  assertEquals(report.serviceRuntimeReady, false);
});
