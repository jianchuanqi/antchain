import { assertEquals } from "@std/assert";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import {
  createLegacyAntChainReceiptNormalizer,
  findLegacyAntChainEventTimestamp,
  inferAntChainTimestampUnit,
} from "./antchain-legacy-receipt.ts";

const ALGORITHM_IDENTITY = "a".repeat(64);
const LABEL_IDENTITY = "b".repeat(64);
const HASH = "c".repeat(64);

function base64Identity(identity: string): string {
  return encodeBase64(
    Uint8Array.from(identity.match(/.{2}/g)!, (pair) => parseInt(pair, 16)),
  );
}

function eventLog(
  identity: string,
  eventName: string,
  payload: Record<string, string>,
) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const prefix: number[] = [];
  let length = json.length;
  do {
    let byte = length & 0x7f;
    length >>>= 7;
    if (length > 0) byte |= 0x80;
    prefix.push(byte);
  } while (length > 0);
  return {
    from: { value: base64Identity("d".repeat(64)) },
    to: { value: base64Identity(identity) },
    logData: encodeBase64(Uint8Array.from([...prefix, ...json])),
    topics: [eventName],
  };
}

const mapper = createLegacyAntChainReceiptNormalizer({
  algorithmRegistry: {
    name: "EDDLAlgorithmRegistryResearch",
    identity: ALGORITHM_IDENTITY,
  },
  ecoLabelRegistry: {
    name: "EDDLEcoLabelRegistryResearch",
    identity: LABEL_IDENTITY,
  },
  blockTimestampUnit: "milliseconds",
});

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      blockNumber: 9001,
      code: 0,
      hash: HASH,
      logs: [],
      output: "",
      result: 0,
      txFinish: true,
      txSuccess: true,
      ...overrides,
    },
  };
}

Deno.test("legacy receipt does not accept the saved gateway pending shape", async () => {
  const saved = JSON.parse(
    await Deno.readTextFile("data/receiptResult.json"),
  );
  assertEquals(mapper({ success: true, data: saved }), { state: "PENDING" });
});

Deno.test("legacy receipt requires both terminal flags", () => {
  assertEquals(
    mapper(receipt({ txFinish: false, txSuccess: true })),
    { state: "PENDING" },
  );
  assertEquals(
    mapper(receipt({ txFinish: true, txSuccess: false })),
    {
      state: "FAILED",
      failureCode: "ANTCHAIN_EXECUTION_0",
      failureMessage: "AntChain returned a terminal unsuccessful receipt",
    },
  );
});

Deno.test("legacy algorithm event is bound to contract, method, inputs and block", () => {
  const payload = {
    algorithmId: "eddl-v1",
    schemeId: "eco-design-digital-identifier",
    version: "1.0.0",
    algorithmHash: `sha256:${"1".repeat(64)}`,
    evaluatorHash: `sha256:${"2".repeat(64)}`,
    status: "DRAFT",
    publisher: "e".repeat(64),
    blockTimestamp: "1786435200000",
  };
  assertEquals(
    mapper(receipt({
      logs: [
        eventLog(ALGORITHM_IDENTITY, "AlgorithmRegistered", payload),
      ],
    })),
    {
      state: "CONFIRMED",
      finality: "FINAL",
      executionStatus: "SUCCESS",
      transactionHash: HASH,
      blockHeight: 9001,
      finalizedAt: "2026-08-11T08:00:00.000Z",
      contractName: "EDDLAlgorithmRegistryResearch",
      methodSignature: "registerAlgorithm(string,string,string,string,string)",
      eventName: "AlgorithmRegistered",
      inputValues: [
        "eddl-v1",
        "eco-design-digital-identifier",
        "1.0.0",
        `sha256:${"1".repeat(64)}`,
        `sha256:${"2".repeat(64)}`,
      ],
    },
  );
});

Deno.test("legacy label issue reconstructs the complete commitment payload", () => {
  const payload = {
    labelId: "EDDL-RESEARCH-1",
    taskId: "task-research-1",
    algorithmId: "eddl-v1",
    algorithmHash: `sha256:${"1".repeat(64)}`,
    inputHash: `sha256:${"2".repeat(64)}`,
    resultHash: `sha256:${"3".repeat(64)}`,
    evidenceHash: `sha256:${"4".repeat(64)}`,
    authorizationHash: `sha256:${"5".repeat(64)}`,
    proofHash: `sha256:${"6".repeat(64)}`,
    expiresAt: "0",
    status: "ACTIVE",
    issuer: "e".repeat(64),
    blockTimestamp: "1786435200000",
  };
  const normalized = mapper(receipt({
    logs: [eventLog(LABEL_IDENTITY, "LabelIssued", payload)],
  }));
  assertEquals(normalized.state, "CONFIRMED");
  if (normalized.state !== "CONFIRMED") return;
  assertEquals(
    normalized.methodSignature,
    "issueLabel(string,string,string,string,string,string,string,string,string,uint64)",
  );
  assertEquals(normalized.inputValues, [
    payload.labelId,
    payload.taskId,
    payload.algorithmId,
    payload.algorithmHash,
    payload.inputHash,
    payload.resultHash,
    payload.evidenceHash,
    payload.authorizationHash,
    payload.proofHash,
    payload.expiresAt,
  ]);
});

Deno.test("algorithm mirror event is bound to the label registry and complete source snapshot", () => {
  const payload = {
    algorithmId: "eddl-v1",
    schemeId: "eco-design-digital-identifier",
    version: "1.0.0",
    algorithmHash: `sha256:${"1".repeat(64)}`,
    evaluatorHash: `sha256:${"2".repeat(64)}`,
    status: "ACTIVE",
    sourceStateHash: `sha256:${"3".repeat(64)}`,
    sourceBlockHeight: "9000",
    validUntil: "1786521600000",
    blockTimestamp: "1786435200000",
  };
  const normalized = mapper(receipt({
    logs: [eventLog(LABEL_IDENTITY, "AlgorithmStateMirrored", payload)],
  }));
  assertEquals(normalized.state, "CONFIRMED");
  if (normalized.state !== "CONFIRMED") return;
  assertEquals(normalized.contractName, "EDDLEcoLabelRegistryResearch");
  assertEquals(
    normalized.methodSignature,
    "syncAlgorithmState(string,string,string,string,string,string,string,uint64,uint64)",
  );
  assertEquals(normalized.inputValues, [
    payload.algorithmId,
    payload.schemeId,
    payload.version,
    payload.algorithmHash,
    payload.evaluatorHash,
    payload.status,
    payload.sourceStateHash,
    payload.sourceBlockHeight,
    payload.validUntil,
  ]);
});

Deno.test("wrong contract identity or missing event is a terminal verification failure", () => {
  const payload = {
    algorithmId: "eddl-v1",
    status: "ACTIVE",
    blockTimestamp: "1786435200000",
  };
  assertEquals(
    mapper(receipt({
      logs: [eventLog(LABEL_IDENTITY, "AlgorithmStatusChanged", payload)],
    })),
    {
      state: "FAILED",
      failureCode: "ANTCHAIN_RECEIPT_UNVERIFIABLE",
      failureMessage:
        "Terminal receipt has no event bound to the configured contract identity and method payload",
    },
  );
});

Deno.test("timestamp unit inference rejects counters and distinguishes Unix units", () => {
  assertEquals(inferAntChainTimestampUnit("1786435200"), "seconds");
  assertEquals(inferAntChainTimestampUnit("1786435200000"), "milliseconds");
  assertEquals(inferAntChainTimestampUnit("9001"), undefined);
  assertEquals(
    findLegacyAntChainEventTimestamp(
      receipt({
        logs: [eventLog(ALGORITHM_IDENTITY, "AlgorithmStatusChanged", {
          algorithmId: "eddl-v1",
          status: "ACTIVE",
          blockTimestamp: "1786435200000",
        })],
      }),
      "AlgorithmStatusChanged",
      ALGORITHM_IDENTITY,
    ),
    "1786435200000",
  );
});
