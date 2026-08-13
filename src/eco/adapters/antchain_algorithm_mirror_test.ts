import { assertEquals, assertRejects } from "@std/assert";
import { buildAlgorithmMirrorSync } from "./antchain-algorithm-mirror.ts";

const algorithm = {
  algorithmId: "eddl-1.0.0",
  schemeId: "eco-design-digital-identifier",
  version: "1.0.0",
  algorithmHash: `sha256:${"1".repeat(64)}`,
  evaluatorHash: `sha256:${"2".repeat(64)}`,
  status: "ACTIVE",
  publisher: "a".repeat(64),
  registeredAt: "1700000000",
  updatedAt: "1700000100",
};

Deno.test("algorithm mirror commitment binds complete readback and anchored block deterministically", async () => {
  const input = {
    algorithmRegistryIdentity: "B".repeat(64),
    algorithmReadback: algorithm,
    activeAlgorithmId: "eddl-1.0.0",
    algorithmActiveState: "1",
    sourceBlockHeight: 123,
    sourceBlockHash: `0x${"C".repeat(64)}`,
    sourceBlockTimestamp: 1_700_000_200,
    timestampUnit: "seconds" as const,
    observationMode: "LATEST_BLOCK_STABLE_WINDOW" as const,
  };
  const first = await buildAlgorithmMirrorSync(input);
  const second = await buildAlgorithmMirrorSync({
    ...input,
    algorithmReadback: Object.fromEntries(
      Object.entries(algorithm).reverse(),
    ),
  });
  assertEquals(first.sourceStateHash, second.sourceStateHash);
  assertEquals(first.validUntil, "1700086600");
  assertEquals(first.values.slice(0, 6), [
    "eddl-1.0.0",
    "eco-design-digital-identifier",
    "1.0.0",
    `sha256:${"1".repeat(64)}`,
    `sha256:${"2".repeat(64)}`,
    "ACTIVE",
  ]);
  assertEquals(first.values.slice(6), [
    first.sourceStateHash,
    "123",
    "1700086600",
  ]);
});

Deno.test("algorithm mirror builder rejects partial, inactive, or unanchored snapshots", async () => {
  await assertRejects(() =>
    buildAlgorithmMirrorSync({
      algorithmRegistryIdentity: "b".repeat(64),
      algorithmReadback: { ...algorithm, publisher: undefined },
      activeAlgorithmId: "eddl-1.0.0",
      algorithmActiveState: "1",
      sourceBlockHeight: 123,
      sourceBlockHash: "c".repeat(64),
      sourceBlockTimestamp: 1_700_000_200,
      timestampUnit: "seconds",
      observationMode: "LATEST_BLOCK_STABLE_WINDOW",
    })
  );
  await assertRejects(() =>
    buildAlgorithmMirrorSync({
      algorithmRegistryIdentity: "b".repeat(64),
      algorithmReadback: algorithm,
      activeAlgorithmId: "other",
      algorithmActiveState: "1",
      sourceBlockHeight: 123,
      sourceBlockHash: "c".repeat(64),
      sourceBlockTimestamp: 1_700_000_200,
      timestampUnit: "seconds",
      observationMode: "LATEST_BLOCK_STABLE_WINDOW",
    })
  );
  await assertRejects(() =>
    buildAlgorithmMirrorSync({
      algorithmRegistryIdentity: "b".repeat(64),
      algorithmReadback: algorithm,
      activeAlgorithmId: "eddl-1.0.0",
      algorithmActiveState: "1",
      sourceBlockHeight: 0,
      sourceBlockHash: "c".repeat(64),
      sourceBlockTimestamp: 1_700_000_200,
      timestampUnit: "seconds",
      observationMode: "LATEST_BLOCK_STABLE_WINDOW",
    })
  );
  await assertRejects(() =>
    buildAlgorithmMirrorSync({
      algorithmRegistryIdentity: "b".repeat(64),
      algorithmReadback: algorithm,
      activeAlgorithmId: "eddl-1.0.0",
      algorithmActiveState: "1",
      sourceBlockHeight: 123,
      sourceBlockHash: "c".repeat(64),
      sourceBlockTimestamp: 1_700_000_200_000,
      timestampUnit: "milliseconds",
      observationMode: "LATEST_BLOCK_STABLE_WINDOW",
    })
  );
});
