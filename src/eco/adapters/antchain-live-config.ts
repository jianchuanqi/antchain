import { createPrivateKey, createSign } from "node:crypto";
import { isAbsolute, resolve } from "std/path/mod.ts";
import { load } from "std/dotenv/mod.ts";
import bundledReleaseManifest from "../../../contracts/eco-label/releases/eddl-chain-algorithm-release.v1.json" with {
  type: "json",
};

const RELEASE_SCHEMA = "eddl-chain-algorithm-release/v1";
const RELEASE_PROJECT = "R-2026-001-WP01-eco-design-labelling";
const RELEASE_SCHEME = "eco-design-digital-identifier";
const RELEASE_HASH = /^sha256:[a-f0-9]{64}$/;
const RELEASE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const BUNDLED_RELEASE_PATH =
  "contracts/eco-label/releases/eddl-chain-algorithm-release.v1.json";

export interface EddlChainAlgorithmReleaseManifest {
  schemaVersion: "eddl-chain-algorithm-release/v1";
  projectId: string;
  schemeId: string;
  algorithmId: string;
  version: string;
  algorithmHash: string;
  sourceArtifactDigest: string;
  evaluatorHash: string;
  evaluatorHashSource: "signedTemplateBundle.payload.evaluator.artifactDigest";
  evaluatorDescriptorDigest: string;
  evaluatorArtifactStatus: "UNPUBLISHED";
  formalIssuanceAllowed: false;
  generatedFrom: {
    ruleSource: string;
    bundlePublisher: string;
  };
}

export interface EddlResearchChainRelease
  extends EddlChainAlgorithmReleaseManifest {
  algorithmRegistryName: string;
  ecoLabelRegistryName: string;
  pilotLabelId: string;
  pilotTaskId: string;
}

function asReleaseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EDDL chain algorithm release must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function releaseString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`EDDL chain algorithm release ${field} is missing`);
  }
  return value;
}

export function validateEddlChainAlgorithmReleaseManifest(
  value: unknown,
): EddlChainAlgorithmReleaseManifest {
  const record = asReleaseRecord(value);
  const schemaVersion = releaseString(record, "schemaVersion");
  const projectId = releaseString(record, "projectId");
  const schemeId = releaseString(record, "schemeId");
  const algorithmId = releaseString(record, "algorithmId");
  const version = releaseString(record, "version");
  const algorithmHash = releaseString(record, "algorithmHash");
  const sourceArtifactDigest = releaseString(record, "sourceArtifactDigest");
  const evaluatorHash = releaseString(record, "evaluatorHash");
  const evaluatorHashSource = releaseString(record, "evaluatorHashSource");
  const evaluatorDescriptorDigest = releaseString(
    record,
    "evaluatorDescriptorDigest",
  );
  const evaluatorArtifactStatus = releaseString(
    record,
    "evaluatorArtifactStatus",
  );
  const generatedFrom = asReleaseRecord(record.generatedFrom);
  const ruleSource = releaseString(generatedFrom, "ruleSource");
  const bundlePublisher = releaseString(generatedFrom, "bundlePublisher");
  if (schemaVersion !== RELEASE_SCHEMA) {
    throw new Error(`EDDL chain algorithm release must use ${RELEASE_SCHEMA}`);
  }
  if (projectId !== RELEASE_PROJECT) {
    throw new Error("EDDL chain algorithm release projectId is unexpected");
  }
  if (schemeId !== RELEASE_SCHEME) {
    throw new Error(
      `EDDL chain algorithm release schemeId must be ${RELEASE_SCHEME}`,
    );
  }
  for (
    const [field, candidate] of [
      ["algorithmId", algorithmId],
      ["version", version],
    ] as const
  ) {
    if (!RELEASE_IDENTIFIER.test(candidate)) {
      throw new Error(`EDDL chain algorithm release ${field} is invalid`);
    }
  }
  for (
    const [field, candidate] of [
      ["algorithmHash", algorithmHash],
      ["sourceArtifactDigest", sourceArtifactDigest],
      ["evaluatorHash", evaluatorHash],
      ["evaluatorDescriptorDigest", evaluatorDescriptorDigest],
    ] as const
  ) {
    if (!RELEASE_HASH.test(candidate)) {
      throw new Error(`EDDL chain algorithm release ${field} is invalid`);
    }
  }
  if (
    evaluatorHashSource !==
      "signedTemplateBundle.payload.evaluator.artifactDigest"
  ) {
    throw new Error(
      "EDDL chain algorithm release evaluatorHash must come from the signed bundle artifactDigest",
    );
  }
  if (evaluatorArtifactStatus !== "UNPUBLISHED") {
    throw new Error(
      "The research release only accepts an UNPUBLISHED evaluator artifact",
    );
  }
  if (record.formalIssuanceAllowed !== false) {
    throw new Error("The research release cannot allow formal issuance");
  }
  return Object.freeze({
    schemaVersion: RELEASE_SCHEMA,
    projectId,
    schemeId,
    algorithmId,
    version,
    algorithmHash,
    sourceArtifactDigest,
    evaluatorHash,
    evaluatorHashSource:
      "signedTemplateBundle.payload.evaluator.artifactDigest",
    evaluatorDescriptorDigest,
    evaluatorArtifactStatus: "UNPUBLISHED",
    formalIssuanceAllowed: false,
    generatedFrom: Object.freeze({ ruleSource, bundlePublisher }),
  });
}

function createResearchChainRelease(
  manifest: EddlChainAlgorithmReleaseManifest,
): EddlResearchChainRelease {
  return Object.freeze({
    ...manifest,
    algorithmRegistryName: "R2026001EDDLAlgorithmRegistryV1",
    ecoLabelRegistryName: "R2026001EDDLEcoLabelRegistryCompatV2",
    pilotLabelId: "EDDL-RESEARCH-2026-001-COMPAT-002",
    pilotTaskId: "R2026001-ANTCHAIN-COMPAT-002",
  });
}

export const EDDL_RESEARCH_CHAIN_RELEASE = createResearchChainRelease(
  validateEddlChainAlgorithmReleaseManifest(bundledReleaseManifest),
);

export interface AntChainLiveConfig {
  contractProfile: "unified-myfish-v1" | "compat-v2";
  restUrl: string;
  bizId: string;
  accessId: string;
  accessSecret: string;
  account: string;
  tenantId: string;
  kmsId: string;
  blockTimestampUnit: "auto" | "seconds" | "milliseconds";
  algorithmRegistryName: string;
  ecoLabelRegistryName: string;
  algorithmId: string;
  schemeId: string;
  algorithmVersion: string;
  algorithmHash: string;
  evaluatorHash: string;
  pilotLabelId: string;
  pilotTaskId: string;
  pilotInputHash?: string;
  pilotResultHash?: string;
  pilotEvidenceHash?: string;
  pilotAuthorizationHash?: string;
  pilotProofHash?: string;
  priorMirrorEvidencePath?: string;
  evidenceDirectory: string;
  allowExistingContracts: boolean;
  receiptTimeoutMs: number;
}

export interface AntChainLivePreflightReport {
  ready: boolean;
  liveWriteEnabled: boolean;
  target: {
    protocol?: string;
    host?: string;
    port?: string;
    reachable: boolean;
    authenticated: boolean;
    httpStatus?: number;
  };
  credentials: {
    accessId: "PRESENT" | "MISSING";
    accessSecret: "VALID_RSA_PRIVATE_KEY" | "MISSING" | "INVALID";
    account: "PRESENT" | "MISSING";
    tenantId: "PRESENT" | "MISSING";
    kmsId: "PRESENT" | "MISSING";
    mode: "KMS";
  };
  deployment: {
    algorithmRegistryName: string;
    algorithmRegistryIdentity: string;
    ecoLabelRegistryName: string;
    ecoLabelRegistryIdentity: string;
    blockTimestampUnit: string | null;
    allowExistingContracts: boolean;
  };
  releaseManifest: {
    path: string;
    digest?: string;
    source: "BUNDLED" | "EXTERNAL";
    valid: boolean;
  };
  release: EddlResearchChainRelease;
  artifacts: Array<{
    role: "AlgorithmRegistry" | "EcoLabelRegistry" | "UnifiedRegistry";
    wascPath: string;
    abiPath: string;
    wascDigest?: string;
    abiDigest?: string;
    present: boolean;
  }>;
  blockers: string[];
  warnings: string[];
}

export interface AntChainLiveResolution {
  config?: AntChainLiveConfig;
  report: AntChainLivePreflightReport;
}

type Environment = Record<string, string>;

function pick(environment: Environment, ...names: string[]): string {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return "";
}

async function readPemReference(
  value: string,
  workingDirectory: string,
): Promise<string> {
  if (!value) return "";
  if (value.includes("-----BEGIN")) return value.replaceAll("\\n", "\n");
  try {
    return await Deno.readTextFile(resolve(workingDirectory, value));
  } catch {
    return value;
  }
}

async function sha256File(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${
    Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")).join("")
  }`;
}

async function sha256Identity(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function artifactReport(
  workingDirectory: string,
  role: "AlgorithmRegistry" | "EcoLabelRegistry" | "UnifiedRegistry",
  directory: string,
): Promise<AntChainLivePreflightReport["artifacts"][number]> {
  const wascPath = resolve(workingDirectory, directory, "dist/index.wasc");
  const abiPath = resolve(workingDirectory, directory, "dist/index.abi");
  try {
    return {
      role,
      wascPath,
      abiPath,
      wascDigest: await sha256File(wascPath),
      abiDigest: await sha256File(abiPath),
      present: true,
    };
  } catch {
    return { role, wascPath, abiPath, present: false };
  }
}

function safeInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function resolveReleaseManifest(
  workingDirectory: string,
  environment: Environment,
  blockers: string[],
): Promise<{
  release: EddlResearchChainRelease;
  report: AntChainLivePreflightReport["releaseManifest"];
}> {
  const configuredPath = pick(
    environment,
    "EDDL_CHAIN_ALGORITHM_RELEASE_FILE",
  );
  const source: "BUNDLED" | "EXTERNAL" = configuredPath
    ? "EXTERNAL"
    : "BUNDLED";
  if (configuredPath && !isAbsolute(configuredPath)) {
    blockers.push("EDDL_CHAIN_ALGORITHM_RELEASE_FILE must be an absolute path");
    return {
      release: EDDL_RESEARCH_CHAIN_RELEASE,
      report: { path: configuredPath, source, valid: false },
    };
  }
  const path = configuredPath ||
    resolve(workingDirectory, BUNDLED_RELEASE_PATH);
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    const manifest = validateEddlChainAlgorithmReleaseManifest(parsed);
    const digest = await sha256File(path);
    const expectedDigest = pick(
      environment,
      "EDDL_CHAIN_ALGORITHM_RELEASE_DIGEST",
    );
    if (expectedDigest && !RELEASE_HASH.test(expectedDigest)) {
      blockers.push(
        "EDDL_CHAIN_ALGORITHM_RELEASE_DIGEST must be a lowercase sha256 reference",
      );
      return {
        release: createResearchChainRelease(manifest),
        report: { path, digest, source, valid: false },
      };
    }
    if (expectedDigest && expectedDigest !== digest) {
      blockers.push(
        "EDDL chain algorithm release file does not match its pinned digest",
      );
      return {
        release: createResearchChainRelease(manifest),
        report: { path, digest, source, valid: false },
      };
    }
    return {
      release: createResearchChainRelease(manifest),
      report: { path, digest, source, valid: true },
    };
  } catch (error) {
    blockers.push(
      `EDDL chain algorithm release manifest is invalid or unreadable: ${
        error instanceof Error ? error.message : "UNKNOWN"
      }`,
    );
    return {
      release: EDDL_RESEARCH_CHAIN_RELEASE,
      report: { path, source, valid: false },
    };
  }
}

export async function resolveAntChainLiveConfig({
  workingDirectory = Deno.cwd(),
  envPath = ".env",
  probeNetwork = true,
  environment: environmentOverrides,
}: {
  workingDirectory?: string;
  envPath?: string;
  probeNetwork?: boolean;
  environment?: Environment;
} = {}): Promise<AntChainLiveResolution> {
  let fileEnvironment: Environment = {};
  try {
    fileEnvironment = await load({
      envPath: resolve(workingDirectory, envPath),
      export: false,
    });
  } catch {
    // A missing .env is a normal preflight outcome; individual missing keys
    // are reported below without exposing any credential values.
  }
  const processEnvironment = environmentOverrides ?? Deno.env.toObject();
  const environment = { ...fileEnvironment, ...processEnvironment };
  const blockers: string[] = [];
  const warnings: string[] = [];
  const resolvedRelease = await resolveReleaseManifest(
    workingDirectory,
    environment,
    blockers,
  );
  const release = resolvedRelease.release;
  const configuredContractProfile = pick(
    environment,
    "ECO_ANTCHAIN_CONTRACT_PROFILE",
  );
  if (
    configuredContractProfile &&
    configuredContractProfile !== "unified-myfish-v1" &&
    configuredContractProfile !== "compat-v2"
  ) {
    blockers.push(
      "ECO_ANTCHAIN_CONTRACT_PROFILE must be unified-myfish-v1 or compat-v2",
    );
  }
  const contractProfile = configuredContractProfile === "compat-v2"
    ? "compat-v2"
    : "unified-myfish-v1";
  const unifiedContractName = pick(
    environment,
    "ECO_UNIFIED_REGISTRY_CONTRACT",
  ) || "R2026001EDDLEcoLabelRegistryUnifiedV2";
  const restUrl = pick(
    environment,
    "ANTCHAIN_REST_URL",
    "BLOCKCHAIN_REST_URL",
  );
  const bizId = pick(environment, "ANTCHAIN_BIZ_ID", "BLOCKCHAIN_BIZ_ID");
  const accessId = pick(
    environment,
    "ANTCHAIN_ACCESS_ID",
    "BLOCKCHAIN_ACCESS_ID",
  );
  const account = pick(
    environment,
    "ANTCHAIN_ACCOUNT",
    "BLOCKCHAIN_ACCOUNT",
  );
  const tenantId = pick(
    environment,
    "ANTCHAIN_TENANT_ID",
    "BLOCKCHAIN_TENANT_ID",
  );
  const kmsId = pick(
    environment,
    "ANTCHAIN_KMS_ID",
    "BLOCKCHAIN_KMS_KEY_ID",
  );
  const accessSecretFile = pick(environment, "ANTCHAIN_ACCESS_SECRET_FILE");
  const accessSecretReference = accessSecretFile ||
    pick(environment, "ANTCHAIN_ACCESS_SECRET");
  const accessSecret = await readPemReference(
    accessSecretReference,
    workingDirectory,
  );
  const algorithmRegistryName = contractProfile === "unified-myfish-v1"
    ? unifiedContractName
    : pick(
      environment,
      "ECO_ALGORITHM_REGISTRY_CONTRACT",
    ) || release.algorithmRegistryName;
  const ecoLabelRegistryName = contractProfile === "unified-myfish-v1"
    ? unifiedContractName
    : pick(
      environment,
      "ECO_LABEL_REGISTRY_CONTRACT",
    ) || release.ecoLabelRegistryName;
  const timestampCandidate = pick(
    environment,
    "ECO_ANTCHAIN_BLOCK_TIMESTAMP_UNIT",
  );
  const blockTimestampUnit = timestampCandidate === "seconds" ||
      timestampCandidate === "milliseconds"
    ? timestampCandidate
    : "auto";
  let accessSecretState:
    AntChainLivePreflightReport["credentials"]["accessSecret"] = "MISSING";
  if (accessSecret) {
    try {
      const key = createPrivateKey(accessSecret);
      accessSecretState = key.asymmetricKeyType === "rsa"
        ? "VALID_RSA_PRIVATE_KEY"
        : "INVALID";
    } catch {
      accessSecretState = "INVALID";
    }
  }
  if (!restUrl) {
    blockers.push("ANTCHAIN_REST_URL/BLOCKCHAIN_REST_URL is missing");
  }
  if (!bizId) blockers.push("ANTCHAIN_BIZ_ID/BLOCKCHAIN_BIZ_ID is missing");
  if (!accessId) {
    blockers.push("ANTCHAIN_ACCESS_ID/BLOCKCHAIN_ACCESS_ID is missing");
  }
  if (accessSecretState === "MISSING") {
    blockers.push(
      "ANTCHAIN_ACCESS_SECRET or ANTCHAIN_ACCESS_SECRET_FILE is missing",
    );
  } else if (accessSecretState === "INVALID") {
    blockers.push("AntChain REST access secret is not a valid RSA private key");
  }
  if (accessSecretFile) {
    if (!isAbsolute(accessSecretFile)) {
      blockers.push("ANTCHAIN_ACCESS_SECRET_FILE must be an absolute path");
    } else {
      try {
        const stat = await Deno.stat(accessSecretFile);
        if (!stat.isFile) {
          blockers.push("ANTCHAIN_ACCESS_SECRET_FILE is not a regular file");
        } else if (stat.mode !== null && (stat.mode & 0o077) !== 0) {
          blockers.push(
            "ANTCHAIN_ACCESS_SECRET_FILE must not be readable by group or other users (use mode 600)",
          );
        }
      } catch {
        blockers.push("ANTCHAIN_ACCESS_SECRET_FILE cannot be read");
      }
    }
  }
  if (!account) blockers.push("ANTCHAIN_ACCOUNT/BLOCKCHAIN_ACCOUNT is missing");
  if (!tenantId) {
    blockers.push("ANTCHAIN_TENANT_ID/BLOCKCHAIN_TENANT_ID is missing");
  }
  if (!kmsId) blockers.push("ANTCHAIN_KMS_ID/BLOCKCHAIN_KMS_KEY_ID is missing");
  if (
    Boolean(pick(environment, "MYFISH_DEBUG")) ||
    pick(environment, "NODE_ENV") === "development" ||
    Boolean(pick(environment, "DEBUG"))
  ) {
    blockers.push(
      "DEBUG and MYFISH_DEBUG must be empty and NODE_ENV must not be development because the upstream SDK logs access secrets, tokens, and request bodies",
    );
  }
  if (blockTimestampUnit === "auto") {
    warnings.push(
      "Block timestamp unit is not pinned yet; the live runner must infer it from the first contract event, compare it with that block's header, and record the verified setting",
    );
  }
  if (
    contractProfile !== "unified-myfish-v1" &&
    algorithmRegistryName === ecoLabelRegistryName
  ) {
    blockers.push("The two deployed contract names must be different");
  }
  if (!/^[-A-Za-z0-9_.:]{1,128}$/.test(algorithmRegistryName)) {
    blockers.push("AlgorithmRegistry contract name is invalid");
  }
  if (!/^[-A-Za-z0-9_.:]{1,128}$/.test(ecoLabelRegistryName)) {
    blockers.push("EcoLabelRegistry contract name is invalid");
  }
  for (
    const [environmentName, expected] of [
      ["ECO_ALGORITHM_ID", release.algorithmId],
      ["ECO_SCHEME_ID", release.schemeId],
      ["ECO_ALGORITHM_VERSION", release.version],
      ["ECO_ALGORITHM_HASH", release.algorithmHash],
      ["ECO_EVALUATOR_HASH", release.evaluatorHash],
    ] as const
  ) {
    const supplied = pick(environment, environmentName);
    if (supplied && supplied !== expected) {
      blockers.push(
        `${environmentName} conflicts with the validated EDDL chain algorithm release manifest`,
      );
    }
  }
  for (
    const environmentName of [
      "ECO_ANTCHAIN_PILOT_INPUT_HASH",
      "ECO_ANTCHAIN_PILOT_RESULT_HASH",
      "ECO_ANTCHAIN_PILOT_EVIDENCE_HASH",
      "ECO_ANTCHAIN_PILOT_AUTHORIZATION_HASH",
      "ECO_ANTCHAIN_PILOT_PROOF_HASH",
    ]
  ) {
    const supplied = pick(environment, environmentName);
    if (supplied && !RELEASE_HASH.test(supplied)) {
      blockers.push(`${environmentName} must be a lowercase sha256: reference`);
    }
  }

  let parsedEndpoint: URL | undefined;
  try {
    parsedEndpoint = new URL(restUrl);
    if (parsedEndpoint.protocol !== "https:") {
      warnings.push(
        "The configured research gateway uses plain HTTP; it is not a production transport",
      );
    }
  } catch {
    if (restUrl) blockers.push("AntChain REST URL is invalid");
  }
  const target: AntChainLivePreflightReport["target"] = {
    protocol: parsedEndpoint?.protocol,
    host: parsedEndpoint?.hostname,
    port: parsedEndpoint?.port,
    reachable: false,
    authenticated: false,
  };
  if (probeNetwork && parsedEndpoint) {
    try {
      const response = await fetch(
        new URL("/api/contract/shakeHand", parsedEndpoint),
        { method: "GET", redirect: "error" },
      );
      target.reachable = true;
      target.httpStatus = response.status;
      await response.body?.cancel();
    } catch {
      blockers.push("Configured AntChain REST gateway is not reachable");
    }
  }
  if (
    probeNetwork && parsedEndpoint && target.reachable && accessId &&
    accessSecretState === "VALID_RSA_PRIVATE_KEY"
  ) {
    try {
      const time = Date.now().toString();
      const signer = createSign("RSA-SHA256");
      signer.update(`${accessId}${time}`, "utf8");
      const secret = signer.sign(accessSecret).toString("hex");
      const response = await fetch(
        new URL("/api/contract/shakeHand", parsedEndpoint),
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json;charset=UTF-8" },
          body: JSON.stringify({ accessId, time, secret }),
        },
      );
      const body = await response.json() as Record<string, unknown>;
      target.authenticated = response.ok && body.success === true &&
        String(body.code) === "200" && typeof body.data === "string" &&
        body.data.length > 0;
      if (!target.authenticated) {
        blockers.push(
          "AntChain REST handshake failed for the configured access id and RSA key",
        );
      }
    } catch {
      blockers.push(
        "AntChain REST handshake failed for the configured access id and RSA key",
      );
    }
  }

  const artifacts = contractProfile === "unified-myfish-v1"
    ? [
      await artifactReport(
        workingDirectory,
        "UnifiedRegistry",
        "contracts/eco-label/unified-registry",
      ),
    ]
    : await Promise.all([
      artifactReport(
        workingDirectory,
        "AlgorithmRegistry",
        "contracts/eco-label/algorithm-registry",
      ),
      artifactReport(
        workingDirectory,
        "EcoLabelRegistry",
        "contracts/eco-label/eco-label-registry",
      ),
    ]);
  if (artifacts.some((artifact) => !artifact.present)) {
    blockers.push("Compiled ABI/WASC artifacts are missing");
  }
  warnings.push(
    "The evaluator commitment is a reproducible build-context digest, not a published OCI manifest digest; this deployment remains RESEARCH_TRIAL",
  );
  const liveWriteEnabled = pick(
    environment,
    "RUN_ANTCHAIN_ECO_LABEL_LIVE",
  ) === "true";
  const selectedRelease: EddlResearchChainRelease = contractProfile ===
      "unified-myfish-v1"
    ? Object.freeze({
      ...release,
      algorithmRegistryName: unifiedContractName,
      ecoLabelRegistryName: unifiedContractName,
      pilotLabelId: pick(
        environment,
        "ECO_ANTCHAIN_UNIFIED_PILOT_LABEL_ID",
      ) || "EDDL-RESEARCH-2026-001-UNIFIED-001",
      pilotTaskId: pick(
        environment,
        "ECO_ANTCHAIN_UNIFIED_PILOT_TASK_ID",
      ) || "R2026001-ANTCHAIN-UNIFIED-001",
    })
    : release;
  const report: AntChainLivePreflightReport = {
    ready: blockers.length === 0,
    liveWriteEnabled,
    target,
    credentials: {
      accessId: accessId ? "PRESENT" : "MISSING",
      accessSecret: accessSecretState,
      account: account ? "PRESENT" : "MISSING",
      tenantId: tenantId ? "PRESENT" : "MISSING",
      kmsId: kmsId ? "PRESENT" : "MISSING",
      mode: "KMS",
    },
    deployment: {
      algorithmRegistryName,
      algorithmRegistryIdentity: await sha256Identity(algorithmRegistryName),
      ecoLabelRegistryName,
      ecoLabelRegistryIdentity: await sha256Identity(ecoLabelRegistryName),
      blockTimestampUnit,
      allowExistingContracts: pick(
        environment,
        "ECO_ANTCHAIN_ALLOW_EXISTING",
      ) === "true",
    },
    releaseManifest: resolvedRelease.report,
    release: selectedRelease,
    artifacts,
    blockers,
    warnings,
  };
  if (!report.ready) return { report };
  return {
    report,
    config: {
      contractProfile,
      restUrl,
      bizId,
      accessId,
      accessSecret,
      account,
      tenantId,
      kmsId,
      blockTimestampUnit,
      algorithmRegistryName,
      ecoLabelRegistryName,
      algorithmId: selectedRelease.algorithmId,
      schemeId: selectedRelease.schemeId,
      algorithmVersion: selectedRelease.version,
      algorithmHash: selectedRelease.algorithmHash,
      evaluatorHash: selectedRelease.evaluatorHash,
      pilotLabelId: contractProfile === "unified-myfish-v1"
        ? (pick(environment, "ECO_ANTCHAIN_UNIFIED_PILOT_LABEL_ID") ||
          "EDDL-RESEARCH-2026-001-UNIFIED-001")
        : (pick(environment, "ECO_ANTCHAIN_PILOT_LABEL_ID") ||
          selectedRelease.pilotLabelId),
      pilotTaskId: contractProfile === "unified-myfish-v1"
        ? (pick(environment, "ECO_ANTCHAIN_UNIFIED_PILOT_TASK_ID") ||
          "R2026001-ANTCHAIN-UNIFIED-001")
        : (pick(environment, "ECO_ANTCHAIN_PILOT_TASK_ID") ||
          selectedRelease.pilotTaskId),
      pilotInputHash: pick(environment, "ECO_ANTCHAIN_PILOT_INPUT_HASH"),
      pilotResultHash: pick(environment, "ECO_ANTCHAIN_PILOT_RESULT_HASH"),
      pilotEvidenceHash: pick(
        environment,
        "ECO_ANTCHAIN_PILOT_EVIDENCE_HASH",
      ),
      pilotAuthorizationHash: pick(
        environment,
        "ECO_ANTCHAIN_PILOT_AUTHORIZATION_HASH",
      ),
      pilotProofHash: pick(environment, "ECO_ANTCHAIN_PILOT_PROOF_HASH"),
      priorMirrorEvidencePath: pick(
          environment,
          "ECO_ANTCHAIN_PRIOR_MIRROR_EVIDENCE_PATH",
        )
        ? resolve(
          workingDirectory,
          pick(environment, "ECO_ANTCHAIN_PRIOR_MIRROR_EVIDENCE_PATH"),
        )
        : undefined,
      evidenceDirectory: resolve(
        workingDirectory,
        pick(environment, "ECO_ANTCHAIN_EVIDENCE_DIR") ||
          ".codex-local/eco-label-antchain-live",
      ),
      allowExistingContracts: report.deployment.allowExistingContracts,
      receiptTimeoutMs: safeInteger(
        pick(environment, "ECO_ANTCHAIN_RECEIPT_TIMEOUT_MS"),
        120_000,
      ),
    },
  };
}
