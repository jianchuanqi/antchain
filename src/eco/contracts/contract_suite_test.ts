import { assert, assertEquals } from "@std/assert";
import {
  generateAccuracyReport,
  getFrozenContractScenarios,
  runContractScenario,
} from "./conformance.ts";

Deno.test("all frozen contract scenarios match the oracle", () => {
  const results = getFrozenContractScenarios().map(runContractScenario);
  const failures = results.filter((result) => !result.passed);
  assertEquals(failures, []);
});

Deno.test("contract suite exceeds 95 percent and security invariants are 100 percent", async () => {
  const report = await generateAccuracyReport();
  assert(report.accuracyPercent >= 95);
  assertEquals(report.securityAccuracyPercent, 100);
  assert(report.thresholdMet);
  assert(report.securityTargetMet);
  assert(report.oracleHash.startsWith("sha256:"));
});

Deno.test("compiled EcoLabelRegistry ABI exposes binding and governed mirror methods", async () => {
  const abi = JSON.parse(
    await Deno.readTextFile(
      "contracts/eco-label/eco-label-registry/dist/index.abi",
    ),
  ) as {
    interfaces: Array<{ name: string }>;
    structs: Array<{ name: string; fields: unknown[]; results: string[] }>;
  };
  assert(
    abi.interfaces.some((entry) =>
      entry.name === "getAlgorithmRegistryContractId"
    ),
  );
  const getter = abi.structs.find((entry) =>
    entry.name === "getAlgorithmRegistryContractId"
  );
  assertEquals(getter?.fields, []);
  assertEquals(getter?.results, ["string"]);
  for (
    const name of [
      "syncAlgorithmState",
      "getAlgorithmStateMirror",
      "getActiveMirroredAlgorithmId",
      "isMirroredAlgorithmActive",
    ]
  ) {
    assert(
      abi.interfaces.some((entry) => entry.name === name),
      `missing ABI method ${name}`,
    );
  }
  const sync = abi.structs.find((entry) => entry.name === "syncAlgorithmState");
  assertEquals(sync?.fields.length, 9);
  assertEquals(sync?.results, ["string"]);
});

Deno.test("target-chain compatibility contract does not depend on Myfish cross-contract calls", async () => {
  const source = await Deno.readTextFile(
    "contracts/eco-label/eco-label-registry/assembly/index.ts",
  );
  assert(!source.includes("callContract"));
  assert(!source.includes("CallContractArgs"));
  assert(source.includes("ALGORITHM_MIRROR_ADMIN"));
  assert(source.includes("parts.length == 18"));
  assert(!source.includes("const payload = taskId"));
});
