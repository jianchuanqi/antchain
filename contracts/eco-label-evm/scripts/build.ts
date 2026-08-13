import nativeSolc from "npm:solc@0.4.23";
import wrapper from "npm:solc@0.4.23/wrapper.js";
import tar from "npm:tar-stream@3.1.7";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const root = dirname(dirname(fromFileUrl(import.meta.url)));
const sourcePath = join(root, "EcoDesignLabelRegistryV1.sol");
const distPath = join(root, "dist");
const toolchainPath = join(distPath, ".toolchain");
const platformSoljsonPath = join(toolchainPath, "alipay-soljson-0.4.24.cjs");
const platformSolcUrl =
  "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20230428/qzie/alipay-solc-0.4.24.tgz";
const platformSoljsonDigest =
  "b2ce9c3ac286fcb57ea9fd0403a937decfd77b13d45b3be75289e761dd775f2a";
const source = await Deno.readTextFile(sourcePath);
const sourceDigest = new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

const digestBytes = async (bytes: Uint8Array) => {
  const copy = Uint8Array.from(bytes);
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)),
  );
};

async function ensurePlatformCompiler() {
  try {
    const existing = await Deno.readFile(platformSoljsonPath);
    if (await digestBytes(existing) === platformSoljsonDigest) return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const response = await fetch(platformSolcUrl, { redirect: "error" });
  if (!response.ok) {
    throw new Error(
      `AntChain compiler download failed: HTTP ${response.status}`,
    );
  }
  const compressed = new Uint8Array(await response.arrayBuffer());
  const decompressed = new Uint8Array(
    await new Response(
      new Blob([compressed]).stream().pipeThrough(
        new DecompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  );
  const extract = tar.extract();
  let soljson: Uint8Array | undefined;
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (
      header: { name: string },
      stream: Readable,
      next: () => void,
    ) => {
      const chunks: Uint8Array[] = [];
      stream.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      stream.on("end", () => {
        if (header.name === "package/soljson.js") {
          const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          soljson = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            soljson.set(chunk, offset);
            offset += chunk.length;
          }
        }
        next();
      });
      stream.on("error", reject);
      stream.resume();
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    Readable.from([decompressed]).pipe(extract);
  });
  if (!soljson || await digestBytes(soljson) !== platformSoljsonDigest) {
    throw new Error("AntChain compiler digest mismatch");
  }
  await Deno.mkdir(toolchainPath, { recursive: true });
  await Deno.writeFile(platformSoljsonPath, soljson);
}

await Deno.mkdir(distPath, { recursive: true });
await ensurePlatformCompiler();
const require = createRequire(import.meta.url);
const platformSolc = wrapper(require(platformSoljsonPath));
const platformOutput = platformSolc.compile(source, 1);
const platformErrors = Array.isArray(platformOutput.errors)
  ? platformOutput.errors
  : [];
if (platformErrors.length) {
  throw new Error(platformErrors.join("\n"));
}
const platformCompiled = platformOutput.contracts
  ?.[":EcoDesignLabelRegistryV1"];
if (!platformCompiled?.interface || !platformCompiled?.bytecode) {
  throw new Error("AntChain compiler did not return the expected contract");
}
const platformAbi = JSON.parse(platformCompiled.interface);
const platformBytecode = `0x${platformCompiled.bytecode}`;
const platformDeployedBytecode = `0x${platformCompiled.runtimeBytecode}`;

const platformSettings = {
  optimizer: { enabled: true },
  compilerDialect: "antchain-solidity-0.4.24-mod",
};
const nativeReferenceSettings = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "byzantium",
  outputSelection: {
    "*": {
      "*": [
        "abi",
        "metadata",
        "evm.bytecode.object",
        "evm.deployedBytecode.object",
      ],
    },
  },
};
const input = {
  language: "Solidity",
  sources: {
    "EcoDesignLabelRegistryV1.sol": {
      content: source.replace(/\bidentity\b/g, "address"),
    },
  },
  settings: nativeReferenceSettings,
};
const output = JSON.parse(
  nativeSolc.compileStandardWrapper(JSON.stringify(input)),
);
const errors = Array.isArray(output.errors) ? output.errors : [];
const failures = errors.filter((item: { severity?: string }) =>
  item.severity === "error"
);
if (failures.length) {
  throw new Error(
    failures.map((item: { formattedMessage?: string }) =>
      item.formattedMessage ?? String(item)
    ).join("\n"),
  );
}

const compiled = output.contracts?.["EcoDesignLabelRegistryV1.sol"]
  ?.EcoDesignLabelRegistryV1;
if (!compiled?.abi || !compiled?.evm?.bytecode?.object) {
  throw new Error("Solidity compiler did not return the expected contract");
}
const bytecode = `0x${compiled.evm.bytecode.object}`;
const deployedBytecode = `0x${compiled.evm.deployedBytecode.object}`;
const digestText = async (text: string) =>
  `sha256:${
    hex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(text),
        ),
      ),
    )
  }`;
const abiText = JSON.stringify(platformAbi);
const artifact = {
  schemaVersion: "eco-design-label-evm-artifact/v1",
  contractName: "EcoDesignLabelRegistryV1",
  compiler: {
    name: "alipay-solc",
    version: platformSolc.version(),
    distributionUrl: platformSolcUrl,
    soljsonDigest: `sha256:${platformSoljsonDigest}`,
  },
  settings: platformSettings,
  sourceDigest: `sha256:${hex(sourceDigest)}`,
  abiDigest: await digestText(abiText),
  bytecodeDigest: await digestText(platformBytecode.slice(2)),
  deployedBytecodeDigest: await digestText(platformDeployedBytecode.slice(2)),
  abi: platformAbi,
  bytecode: platformBytecode,
  deployedBytecode: platformDeployedBytecode,
  metadata: platformCompiled.metadata
    ? JSON.parse(platformCompiled.metadata)
    : null,
  nativeReference: {
    purpose:
      "Local semantic execution only; not an AntChain deployment artifact",
    compiler: { name: "solc", version: nativeSolc.version() },
    settings: nativeReferenceSettings,
    abi: compiled.abi,
    bytecode,
    deployedBytecode,
  },
};
const deploymentPackage = {
  schemaVersion: "eco-design-label-antchain-evm-deployment-package/v1",
  status: "UNDEPLOYED",
  contractProjectName: "R2026001EcoDesignLabelEVM",
  contractName: artifact.contractName,
  chainName: "标准MYCHAIN合约链",
  vmType: "EVM",
  sourceFile: "EcoDesignLabelRegistryV1.sol",
  constructorArguments: [],
  initialRoleHolder: "platform deployment account (msg.sender)",
  initialRoles: [
    "DEFAULT_ADMIN_ROLE",
    "ALGORITHM_ADMIN_ROLE",
    "LABEL_ISSUER_ROLE",
    "LABEL_LIFECYCLE_ROLE",
  ],
  compiler: artifact.compiler,
  settings: {
    optimizer: platformSettings.optimizer,
    compilerDialect: platformSettings.compilerDialect,
  },
  commitments: {
    sourceDigest: artifact.sourceDigest,
    abiDigest: artifact.abiDigest,
    bytecodeDigest: artifact.bytecodeDigest,
    deployedBytecodeDigest: artifact.deployedBytecodeDigest,
  },
  lifecycle: {
    algorithm: [
      "registerAlgorithm",
      "activateAlgorithm",
      "suspendAlgorithm",
      "retireAlgorithm",
      "getAlgorithm",
      "getActiveAlgorithmId",
      "isAlgorithmActive",
    ],
    label: [
      "issueLabel",
      "suspendLabel",
      "resumeLabel",
      "supersedeLabel",
      "revokeLabel",
      "expireLabel",
      "getLabel",
      "getLabelByTaskId",
    ],
  },
  platformEvidenceRequired: [
    "contractProjectName",
    "chainName",
    "contractId",
    "deploymentTransactionId",
    "deploymentBlockHeight",
    "deployedBytecodeDigest",
  ],
  runtimeBoundary: {
    sdk: "@antchain/jssdk@1.2.1",
    managedRestDeploymentSupported: true,
    managedRestSolidityCallSupportedBySdk: false,
    serviceRuntimeEnabled: false,
    reason:
      "The configured KMS/managed REST provider deploys Solidity but its callContract implementation rejects EVM contracts; an approved EVM invocation path must be fixed before service cutover.",
  },
};

await Deno.writeTextFile(
  join(distPath, "EcoDesignLabelRegistryV1.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
);
await Deno.writeTextFile(
  join(distPath, "EcoDesignLabelRegistryV1.abi.json"),
  `${JSON.stringify(platformAbi, null, 2)}\n`,
);
await Deno.writeTextFile(
  join(distPath, "EcoDesignLabelRegistryV1.bin"),
  `${platformBytecode.slice(2)}\n`,
);
await Deno.writeTextFile(
  join(distPath, "antchain-evm-deployment-package.v1.json"),
  `${JSON.stringify(deploymentPackage, null, 2)}\n`,
);
console.log(JSON.stringify(
  {
    contractName: artifact.contractName,
    compiler: artifact.compiler.version,
    compilerDialect: platformSettings.compilerDialect,
    sourceDigest: artifact.sourceDigest,
    abiDigest: artifact.abiDigest,
    bytecodeDigest: artifact.bytecodeDigest,
    deployedBytecodeDigest: artifact.deployedBytecodeDigest,
  },
  null,
  2,
));
