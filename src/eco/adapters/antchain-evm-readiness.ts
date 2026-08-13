import { isAbsolute, resolve } from "std/path/mod.ts";

type JsonRecord = Record<string, unknown>;

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CONTRACT_ID = /^[a-f0-9]{64}$/i;

export interface AntChainEvmReadinessReport {
  schemaVersion: "eco-design-label-antchain-evm-readiness/v1";
  localPackageReady: boolean;
  platformDeploymentConfigured: boolean;
  serviceRuntimeReady: false;
  artifact: {
    contractName?: string;
    compilerVersion?: string;
    sourceDigest?: string;
    abiDigest?: string;
    bytecodeDigest?: string;
    deployedBytecodeDigest?: string;
  };
  platform: {
    contractProject: "PRESENT" | "MISSING";
    chainName: "PRESENT" | "MISSING";
    contractId: "VALID" | "MISSING" | "INVALID";
    callPath: "MISSING" | "CONFIGURED_UNVERIFIED";
  };
  blockers: string[];
  warnings: string[];
}

function record(value: unknown, description: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be a JSON object`);
  }
  return value as JsonRecord;
}

function stringField(value: JsonRecord, name: string): string {
  const field = value[name];
  if (typeof field !== "string" || !field.trim()) {
    throw new Error(`${name} is missing`);
  }
  return field;
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return `sha256:${
    Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("")
  }`;
}

export async function resolveAntChainEvmReadiness({
  workingDirectory = Deno.cwd(),
  environment = Deno.env.toObject(),
}: {
  workingDirectory?: string;
  environment?: Record<string, string>;
} = {}): Promise<AntChainEvmReadinessReport> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const artifactPath = resolve(
    workingDirectory,
    "contracts/eco-label-evm/dist/EcoDesignLabelRegistryV1.json",
  );
  const sourcePath = resolve(
    workingDirectory,
    "contracts/eco-label-evm/EcoDesignLabelRegistryV1.sol",
  );
  const deploymentPackagePath = resolve(
    workingDirectory,
    "contracts/eco-label-evm/dist/antchain-evm-deployment-package.v1.json",
  );
  const artifactSummary: AntChainEvmReadinessReport["artifact"] = {};
  let localPackageReady = false;

  try {
    const artifact = record(
      JSON.parse(await Deno.readTextFile(artifactPath)),
      "EVM artifact",
    );
    const deploymentPackage = record(
      JSON.parse(await Deno.readTextFile(deploymentPackagePath)),
      "AntChain EVM deployment package",
    );
    const compiler = record(artifact.compiler, "compiler");
    const settings = record(artifact.settings, "settings");
    const commitments = record(deploymentPackage.commitments, "commitments");
    const abi = artifact.abi;
    if (!Array.isArray(abi)) throw new Error("abi must be an array");
    const source = await Deno.readTextFile(sourcePath);
    const sourceDigest = stringField(artifact, "sourceDigest");
    const abiDigest = stringField(artifact, "abiDigest");
    const bytecodeDigest = stringField(artifact, "bytecodeDigest");
    const deployedBytecodeDigest = stringField(
      artifact,
      "deployedBytecodeDigest",
    );
    const bytecode = stringField(artifact, "bytecode");
    const deployedBytecode = stringField(artifact, "deployedBytecode");
    artifactSummary.contractName = stringField(artifact, "contractName");
    artifactSummary.compilerVersion = stringField(compiler, "version");
    artifactSummary.sourceDigest = sourceDigest;
    artifactSummary.abiDigest = abiDigest;
    artifactSummary.bytecodeDigest = bytecodeDigest;
    artifactSummary.deployedBytecodeDigest = deployedBytecodeDigest;

    const actual = {
      sourceDigest: await sha256(source),
      abiDigest: await sha256(JSON.stringify(abi)),
      bytecodeDigest: await sha256(bytecode.replace(/^0x/, "")),
      deployedBytecodeDigest: await sha256(
        deployedBytecode.replace(/^0x/, ""),
      ),
    };
    for (const [name, digest] of Object.entries(actual)) {
      if (!SHA256.test(digest) || digest !== artifact[name]) {
        throw new Error(`${name} does not match the reproducible artifact`);
      }
      if (commitments[name] !== digest) {
        throw new Error(`${name} does not match the deployment package`);
      }
    }
    if (
      !artifactSummary.compilerVersion.startsWith(
        "0.4.24+commit.6eda33a0.mod",
      ) ||
      settings.compilerDialect !== "antchain-solidity-0.4.24-mod" ||
      record(settings.optimizer, "optimizer").enabled !== true
    ) {
      throw new Error("compiler version or EVM target is not pinned");
    }
    if (deploymentPackage.vmType !== "EVM") {
      throw new Error("deployment package vmType must be EVM");
    }
    localPackageReady = true;
  } catch (error) {
    blockers.push(
      `Local EVM deployment package is invalid: ${
        error instanceof Error ? error.message : "UNKNOWN"
      }`,
    );
  }

  const contractProject = environment.EDDL_ANTCHAIN_EVM_CONTRACT_PROJECT
    ?.trim();
  const chainName = environment.EDDL_ANTCHAIN_EVM_CHAIN_NAME?.trim();
  const contractId = environment.EDDL_ANTCHAIN_EVM_CONTRACT_ID?.trim();
  const callMode = environment.EDDL_ANTCHAIN_EVM_CALL_MODE?.trim();
  const callEndpoint = environment.EDDL_ANTCHAIN_EVM_CALL_ENDPOINT?.trim();
  const signingKeyFile = environment.EDDL_ANTCHAIN_EVM_ACCOUNT_KEY_FILE?.trim();
  const validContractId = Boolean(contractId && CONTRACT_ID.test(contractId));
  const platformDeploymentConfigured = Boolean(
    contractProject && chainName && validContractId,
  );

  if (!contractProject) {
    blockers.push("EDDL_ANTCHAIN_EVM_CONTRACT_PROJECT is missing");
  }
  if (!chainName) blockers.push("EDDL_ANTCHAIN_EVM_CHAIN_NAME is missing");
  if (!contractId) {
    blockers.push("EDDL_ANTCHAIN_EVM_CONTRACT_ID is missing");
  } else if (!validContractId) {
    blockers.push(
      "EDDL_ANTCHAIN_EVM_CONTRACT_ID must be 64 hexadecimal characters",
    );
  }

  let callPath: AntChainEvmReadinessReport["platform"]["callPath"] = "MISSING";
  if (callMode === "managed-platform-api" && callEndpoint) {
    try {
      const endpoint = new URL(callEndpoint);
      if (endpoint.protocol !== "https:") {
        throw new Error("managed EVM call endpoint must use HTTPS");
      }
      callPath = "CONFIGURED_UNVERIFIED";
    } catch (error) {
      blockers.push(
        error instanceof Error ? error.message : "EVM call endpoint is invalid",
      );
    }
  } else if (callMode === "account-signature" && signingKeyFile) {
    if (!isAbsolute(signingKeyFile)) {
      blockers.push(
        "EDDL_ANTCHAIN_EVM_ACCOUNT_KEY_FILE must be an absolute path",
      );
    } else {
      callPath = "CONFIGURED_UNVERIFIED";
    }
  } else {
    blockers.push(
      "An approved EVM invocation path is missing; @antchain/jssdk@1.2.1 managed REST explicitly rejects Solidity callContract",
    );
  }
  if (callPath === "CONFIGURED_UNVERIFIED") {
    warnings.push(
      "The EVM invocation path is configured but has not yet passed a real register/activate/issue/event/readback contract test",
    );
  }
  warnings.push(
    "Myfish/WASM contract identities are historical research evidence and must not be reused as this EVM contract ID",
  );

  return {
    schemaVersion: "eco-design-label-antchain-evm-readiness/v1",
    localPackageReady,
    platformDeploymentConfigured,
    serviceRuntimeReady: false,
    artifact: artifactSummary,
    platform: {
      contractProject: contractProject ? "PRESENT" : "MISSING",
      chainName: chainName ? "PRESENT" : "MISSING",
      contractId: contractId
        ? (validContractId ? "VALID" : "INVALID")
        : "MISSING",
      callPath,
    },
    blockers,
    warnings,
  };
}
