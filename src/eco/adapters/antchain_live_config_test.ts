import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { resolve } from "std/path/mod.ts";
import bundledRelease from "../../../contracts/eco-label/releases/eddl-chain-algorithm-release.v1.json" with {
  type: "json",
};
import {
  EDDL_RESEARCH_CHAIN_RELEASE,
  resolveAntChainLiveConfig,
  validateEddlChainAlgorithmReleaseManifest,
} from "./antchain-live-config.ts";

const BUNDLE_DIGEST =
  "sha256:825eed2a806a4fd3b40509594c73df2d0f53909483c017edbea5a1aa323c86e3";
const EVALUATOR_ARTIFACT_DIGEST =
  "sha256:5583d1e886d390e799af6d45a7fc0c2a49615002a4d5c5c1032c38d6c8c21938";

Deno.test("bundled chain release is bound to the generated EDDL bundle", () => {
  const release = validateEddlChainAlgorithmReleaseManifest(bundledRelease);
  assertEquals(release.algorithmId, "ECO-IND-FINAL-20260729");
  assertEquals(release.schemeId, "eco-design-digital-identifier");
  assertEquals(release.version, "1.0.0");
  assertEquals(release.algorithmHash, BUNDLE_DIGEST);
  assertEquals(release.evaluatorHash, EVALUATOR_ARTIFACT_DIGEST);
  assertEquals(
    release.evaluatorHashSource,
    "signedTemplateBundle.payload.evaluator.artifactDigest",
  );
  assertEquals(EDDL_RESEARCH_CHAIN_RELEASE.algorithmHash, BUNDLE_DIGEST);
  assertEquals(
    EDDL_RESEARCH_CHAIN_RELEASE.evaluatorHash,
    EVALUATOR_ARTIFACT_DIGEST,
  );
});

Deno.test("historical CompatV2 release metadata remains frozen", () => {
  assertEquals(
    EDDL_RESEARCH_CHAIN_RELEASE.algorithmRegistryName,
    "R2026001EDDLAlgorithmRegistryV1",
  );
  assertEquals(
    EDDL_RESEARCH_CHAIN_RELEASE.ecoLabelRegistryName,
    "R2026001EDDLEcoLabelRegistryCompatV2",
  );
  assertEquals(
    EDDL_RESEARCH_CHAIN_RELEASE.pilotLabelId,
    "EDDL-RESEARCH-2026-001-COMPAT-002",
  );
  assertEquals(
    EDDL_RESEARCH_CHAIN_RELEASE.pilotTaskId,
    "R2026001-ANTCHAIN-COMPAT-002",
  );
});

Deno.test("unified profile selects one Myfish artifact and one contract identity", async () => {
  const resolution = await resolveAntChainLiveConfig({
    workingDirectory: Deno.cwd(),
    envPath: ".does-not-exist",
    probeNetwork: false,
    environment: {},
  });
  assertEquals(
    resolution.report.deployment.algorithmRegistryName,
    "R2026001EDDLEcoLabelRegistryUnifiedV2",
  );
  assertEquals(
    resolution.report.deployment.ecoLabelRegistryName,
    "R2026001EDDLEcoLabelRegistryUnifiedV2",
  );
  assertEquals(resolution.report.artifacts.length, 1);
  assertEquals(resolution.report.artifacts[0]?.role, "UnifiedRegistry");
  assertEquals(resolution.report.artifacts[0]?.present, true);
  assertEquals(
    resolution.report.release.pilotLabelId,
    "EDDL-RESEARCH-2026-001-UNIFIED-001",
  );
});

Deno.test("release validator rejects a substituted bundle or scheme", () => {
  assertThrows(
    () =>
      validateEddlChainAlgorithmReleaseManifest({
        ...bundledRelease,
        algorithmHash: `sha256:${"9".repeat(64)}`,
        schemeId: "eco-design-labelling",
      }),
    Error,
    "schemeId must be eco-design-digital-identifier",
  );
  assertThrows(
    () =>
      validateEddlChainAlgorithmReleaseManifest({
        ...bundledRelease,
        evaluatorHashSource: "self-asserted",
      }),
    Error,
    "signed bundle artifactDigest",
  );
});

Deno.test("environment cannot override the validated EDDL release", async () => {
  const resolution = await resolveAntChainLiveConfig({
    workingDirectory: Deno.cwd(),
    envPath: ".does-not-exist",
    probeNetwork: false,
    environment: {
      ECO_ALGORITHM_HASH: `sha256:${"9".repeat(64)}`,
    },
  });
  assertEquals(resolution.report.release.algorithmHash, BUNDLE_DIGEST);
  assertEquals(resolution.report.releaseManifest.valid, true);
  assertStringIncludes(
    resolution.report.blockers.join("\n"),
    "ECO_ALGORITHM_HASH conflicts with the validated EDDL chain algorithm release manifest",
  );
});

Deno.test("all debug environment variants fail closed before JSSDK use", async () => {
  const debugEnvironments: Array<Record<string, string>> = [
    { DEBUG: "*" },
    { DEBUG: "unrelated-namespace" },
    { MYFISH_DEBUG: "true" },
    { NODE_ENV: "development" },
  ];
  for (const environment of debugEnvironments) {
    const resolution = await resolveAntChainLiveConfig({
      workingDirectory: Deno.cwd(),
      envPath: ".does-not-exist",
      probeNetwork: false,
      environment,
    });
    assertStringIncludes(
      resolution.report.blockers.join("\n"),
      "DEBUG and MYFISH_DEBUG must be empty",
    );
    assertEquals(resolution.config, undefined);
  }
});

Deno.test("live label commitments accept only lowercase sha256 references", async () => {
  const resolution = await resolveAntChainLiveConfig({
    workingDirectory: Deno.cwd(),
    envPath: ".does-not-exist",
    probeNetwork: false,
    environment: {
      ECO_ANTCHAIN_PILOT_RESULT_HASH: "not-a-content-digest",
    },
  });
  assertStringIncludes(
    resolution.report.blockers.join("\n"),
    "ECO_ANTCHAIN_PILOT_RESULT_HASH must be a lowercase sha256: reference",
  );
  assertEquals(resolution.config, undefined);
});

Deno.test("bundled snapshot matches the sibling EDDL generated fixture when present", async () => {
  const sharedPath = resolve(
    Deno.cwd(),
    "../eddl-platform/contracts/fixtures/eddl-chain-algorithm-release.v1.json",
  );
  try {
    const shared = JSON.parse(await Deno.readTextFile(sharedPath));
    assertEquals(shared, bundledRelease);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
});
