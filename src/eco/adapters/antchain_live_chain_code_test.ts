import { assertEquals } from "@std/assert";
import { chainCodeMatchesFrozenWasc } from "./antchain-live-chain-code.ts";

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return `sha256:${
    Array.from(new Uint8Array(value), (byte) =>
      byte.toString(16).padStart(2, "0")).join("")
  }`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

Deno.test("accepts the exact frozen WASC and Myfish 0x02 query wrapper", async () => {
  const wasc = Uint8Array.from([0x77, 0x61, 0x73, 0x63, 0x01, 0x02]);
  const expected = await digest(wasc);
  assertEquals(await chainCodeMatchesFrozenWasc(hex(wasc), expected), true);
  assertEquals(
    await chainCodeMatchesFrozenWasc(
      hex(Uint8Array.from([0x02, ...wasc])),
      expected,
    ),
    true,
  );
});

Deno.test("rejects unknown wrappers and modified WASC payloads", async () => {
  const wasc = Uint8Array.from([0x77, 0x61, 0x73, 0x63, 0x01, 0x02]);
  const expected = await digest(wasc);
  assertEquals(
    await chainCodeMatchesFrozenWasc(
      hex(Uint8Array.from([0x03, ...wasc])),
      expected,
    ),
    false,
  );
  assertEquals(
    await chainCodeMatchesFrozenWasc(
      hex(Uint8Array.from([0x02, ...wasc.slice(0, -1), 0x03])),
      expected,
    ),
    false,
  );
});
