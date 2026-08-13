import { assert, assertEquals, assertRejects } from "@std/assert";
import { ApiResponse } from "../../deps.ts";
import { ContractMethodParams } from "../../core/blockchain/contract/types.ts";
import {
  AntChainLedgerAdapter,
  ContractCallClient,
  ContractReceiptClient,
  strictNormalizedReceiptMapper,
} from "./antchain.ts";

class FakeContract implements ContractCallClient {
  readonly calls: ContractMethodParams[] = [];
  response: ApiResponse = { success: true, data: "gateway-request-1" };

  callMethod(params: ContractMethodParams): Promise<ApiResponse> {
    this.calls.push({ ...params });
    return Promise.resolve(this.response);
  }
}

class FakeReceipts implements ContractReceiptClient {
  readonly requests: string[] = [];
  response: ApiResponse = { success: true, data: { finality: "PENDING" } };

  queryReceipt(requestId: string): Promise<ApiResponse> {
    this.requests.push(requestId);
    return Promise.resolve(this.response);
  }
}

const H = "a".repeat(64);

function adapterFixture() {
  const contract = new FakeContract();
  const receipts = new FakeReceipts();
  const adapter = new AntChainLedgerAdapter(
    contract,
    "algorithm-registry-v1",
    "eco-label-registry-v1",
    receipts,
  );
  return { adapter, contract, receipts };
}

Deno.test("AntChain submission is always pending and uses a stable order id", async () => {
  const { adapter, contract } = adapterFixture();
  const algorithm = {
    id: "eddl-v1",
    version: "1.0.0",
    name: "EDDL",
    schemeId: "eco-design-digital-identifier",
    evaluatorHash: H,
    metrics: [{
      id: "m1",
      name: "metric",
      inputKey: "m1",
      weight: 1,
      min: 0,
      max: 1,
      direction: "HIGHER_IS_BETTER" as const,
    }],
    status: "DRAFT" as const,
    algorithmHash: H,
    createdAt: "2026-08-11T00:00:00.000Z",
  };
  const first = await adapter.registerAlgorithm(algorithm);
  const second = await adapter.registerAlgorithm(algorithm);
  assertEquals(first.status, "PENDING");
  assert(first.transactionId.startsWith("pending-request-"));
  assertEquals(first.requestId, "gateway-request-1");
  assertEquals(contract.calls[0].orderId, contract.calls[1].orderId);
  assertEquals(
    first.receiptVerification?.payloadHash,
    second.receiptVerification?.payloadHash,
  );
  assert(!first.transactionId.includes("gateway-request-1"));
});

Deno.test("AntChain registration requires explicit scheme and evaluator commitments", async () => {
  const { adapter } = adapterFixture();
  await assertRejects(
    () =>
      adapter.registerAlgorithm({
        id: "eddl-v1",
        version: "1.0.0",
        name: "EDDL",
        metrics: [],
        status: "DRAFT",
        algorithmHash: H,
        createdAt: "2026-08-11T00:00:00.000Z",
      }),
    Error,
    "explicit schemeId and signed evaluatorHash",
  );
});

Deno.test("AntChain issuance rejects self-asserted authorization and local compute", async () => {
  const { adapter } = adapterFixture();
  const command = {
    labelId: "EDDL-1",
    taskId: "task-1",
    algorithmId: "eddl-v1",
    algorithmHash: H,
    inputHash: H,
    resultHash: H,
    evidenceHash: H,
    authorizationHash: H,
    proofHash: H,
    authorizationAssurance: "DEVELOPMENT_SELF_ASSERTED" as const,
    computeAssurance: "LOCAL_DETERMINISTIC" as const,
    expiresAtEpochMs: 0,
  };
  await assertRejects(
    () => adapter.issueLabel(command),
    Error,
    "verified eco-design-labelling DataUseGrant",
  );
  const pending = await adapter.issueLabel({
    ...command,
    authorizationAssurance: "VERIFIED_DATA_USE_GRANT",
    computeAssurance: "VERIFIED_TCS",
  });
  assertEquals(pending.status, "PENDING");
});

Deno.test("success true or a hash-shaped submission never counts as final", async () => {
  const { adapter, contract, receipts } = adapterFixture();
  contract.response = { success: true, data: "b".repeat(64) };
  const anchor = await adapter.suspendLabel("EDDL-1");
  assertEquals(anchor.status, "PENDING");
  receipts.response = {
    success: true,
    data: { transactionHash: "c".repeat(64) },
  };
  const reconciled = await adapter.reconcile(anchor);
  assertEquals(reconciled.status, "PENDING");
  assertEquals(reconciled.transactionId, anchor.transactionId);
});

Deno.test("strict final receipt becomes confirmed only after all bindings match", async () => {
  const { adapter, contract, receipts } = adapterFixture();
  const anchor = await adapter.expireLabel("EDDL-1");
  const verification = anchor.receiptVerification!;
  const inputValues = JSON.parse(
    contract.calls[0].inputParamListStr!,
  ) as string[];
  receipts.response = {
    success: true,
    data: {
      finality: "FINAL",
      executionStatus: "SUCCESS",
      transactionHash: "d".repeat(64),
      blockHeight: 321,
      finalizedAt: "2026-08-11T08:00:00.000Z",
      contractName: verification.contractName,
      methodSignature: verification.methodSignature,
      eventName: verification.expectedEvent,
      inputValues,
    },
  };
  const reconciled = await adapter.reconcile(anchor);
  assertEquals(reconciled.status, "CONFIRMED");
  assertEquals(reconciled.transactionId, "d".repeat(64));
  assertEquals(reconciled.blockHeight, 321);
  assertEquals(reconciled.finalizedAt, "2026-08-11T08:00:00.000Z");
  assertEquals(receipts.requests, ["gateway-request-1"]);
});

Deno.test("a final receipt with the wrong event or payload is failed, not confirmed", async () => {
  const { adapter, receipts } = adapterFixture();
  const anchor = await adapter.resumeLabel("EDDL-1");
  const verification = anchor.receiptVerification!;
  receipts.response = {
    success: true,
    data: {
      finality: "FINAL",
      executionStatus: "SUCCESS",
      transactionHash: "e".repeat(64),
      blockHeight: 322,
      finalizedAt: "2026-08-11T08:01:00.000Z",
      contractName: verification.contractName,
      methodSignature: verification.methodSignature,
      eventName: "WrongEvent",
      inputValues: ["EDDL-1"],
    },
  };
  const reconciled = await adapter.reconcile(anchor);
  assertEquals(reconciled.status, "FAILED");
  assertEquals(reconciled.failureCode, "RECEIPT_MISMATCH");
  assertEquals(reconciled.transactionId, anchor.transactionId);

  receipts.response = {
    success: true,
    data: {
      finality: "FINAL",
      executionStatus: "SUCCESS",
      transactionHash: "f".repeat(64),
      blockHeight: 323,
      finalizedAt: "2026-08-11T08:02:00.000Z",
      contractName: verification.contractName,
      methodSignature: verification.methodSignature,
      eventName: verification.expectedEvent,
      inputValues: ["A-DIFFERENT-LABEL"],
    },
  };
  const payloadMismatch = await adapter.reconcile(anchor);
  assertEquals(payloadMismatch.status, "FAILED");
  assertEquals(payloadMismatch.failureCode, "RECEIPT_MISMATCH");
});

Deno.test("an explicit final contract failure maps to FAILED", async () => {
  const { adapter, receipts } = adapterFixture();
  const anchor = await adapter.revokeLabel("EDDL-1", H);
  receipts.response = {
    success: true,
    data: {
      finality: "FINAL",
      executionStatus: "REVERTED",
      failureCode: "UNAUTHORIZED",
      failureMessage: "role check failed",
    },
  };
  const reconciled = await adapter.reconcile(anchor);
  assertEquals(reconciled.status, "FAILED");
  assertEquals(reconciled.failureCode, "UNAUTHORIZED");
});

Deno.test("strict mapper treats malformed success-shaped data as pending", () => {
  assertEquals(
    strictNormalizedReceiptMapper({ success: true, data: "not-json" }),
    { state: "PENDING" },
  );
  assertEquals(
    strictNormalizedReceiptMapper({
      success: true,
      data: {
        finality: "FINAL",
        executionStatus: "SUCCESS",
        transactionHash: "short",
      },
    }),
    { state: "PENDING" },
  );
  assertEquals(
    strictNormalizedReceiptMapper({
      success: false,
      data: {
        finality: "FINAL",
        executionStatus: "SUCCESS",
        transactionHash: "a".repeat(64),
        blockHeight: 1,
        finalizedAt: "2026-08-11T08:00:00.000Z",
        contractName: "contract",
        methodSignature: "method()",
        eventName: "Event",
        inputValues: [],
      },
    }),
    { state: "PENDING" },
  );
});
