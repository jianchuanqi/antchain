import { assertEquals, assertNotEquals } from "@std/assert";
import {
  assessLiveTransactionClosure,
  createLiveTargetBinding,
  REQUIRED_LIVE_OPERATIONS,
} from "./antchain-live-evidence.ts";

Deno.test("target binding changes across biz, tenant, account, and KMS contexts", async () => {
  const base = {
    restUrl: "https://gateway.example.test:8443",
    bizId: "biz-a",
    tenantId: "tenant-a",
    account: "account-a",
    kmsId: "kms-a",
  };
  const expected = await createLiveTargetBinding(base);
  for (
    const [field, value] of [
      ["bizId", "biz-b"],
      ["tenantId", "tenant-b"],
      ["account", "account-b"],
      ["kmsId", "kms-b"],
    ] as const
  ) {
    const changed = await createLiveTargetBinding({ ...base, [field]: value });
    assertNotEquals(changed.profileCommitment, expected.profileCommitment);
  }
  const serialized = JSON.stringify(expected);
  assertEquals(serialized.includes(base.bizId), false);
  assertEquals(serialized.includes(base.tenantId), false);
  assertEquals(serialized.includes(base.account), false);
  assertEquals(serialized.includes(base.kmsId), false);
});

Deno.test("closure completes only when every required write has transaction evidence", () => {
  const completed = assessLiveTransactionClosure({
    operations: REQUIRED_LIVE_OPERATIONS.map((operation) => ({ operation })),
    stateRecoveries: [],
  });
  assertEquals(completed.completed, true);
  assertEquals(completed.status, "COMPLETED_WITH_TRANSACTION_EVIDENCE");

  const preexisting = assessLiveTransactionClosure({
    operations: REQUIRED_LIVE_OPERATIONS.slice(0, -1).map((operation) => ({
      operation,
    })),
    stateRecoveries: [],
  });
  assertEquals(preexisting.completed, false);
  assertEquals(preexisting.status, "PREEXISTING_STATE_VERIFIED");
  assertEquals(preexisting.missingTransactionEvidence, [
    "issue:SyntheticResearchLabel",
  ]);

  const recovered = assessLiveTransactionClosure({
    operations: REQUIRED_LIVE_OPERATIONS.slice(0, -1).map((operation) => ({
      operation,
    })),
    stateRecoveries: [{ operation: "issue:SyntheticResearchLabel" }],
  });
  assertEquals(recovered.completed, false);
  assertEquals(
    recovered.status,
    "STATE_RECOVERED_WITHOUT_TRANSACTION_EVIDENCE",
  );
});
