function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function decodeHex(value: string): Uint8Array | undefined {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    return undefined;
  }
  return Uint8Array.from(
    normalized.match(/.{2}/g) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return `sha256:${
    Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")).join("")
  }`;
}

function hasMyfishWascTypePrefix(bytes: Uint8Array): boolean {
  return bytes.length > 5 && bytes[0] === 0x02 &&
    bytes[1] === 0x77 && bytes[2] === 0x61 && bytes[3] === 0x73 &&
    bytes[4] === 0x63;
}

/**
 * QUERYCONTRACT returns Myfish WASC as hex prefixed by the one-byte code type
 * discriminator 0x02. Deployment accepts the raw WASC bytes. Accept only that
 * documented wrapper and continue to compare the frozen SHA-256 digest.
 */
export async function chainCodeMatchesFrozenWasc(
  chainCode: string,
  expectedDigest: string,
): Promise<boolean> {
  const candidates: Uint8Array[] = [new TextEncoder().encode(chainCode)];
  const base64 = decodeBase64(chainCode);
  const hex = decodeHex(chainCode);
  if (base64) candidates.push(base64);
  if (hex) candidates.push(hex);
  for (const candidate of candidates) {
    if (await sha256Bytes(candidate) === expectedDigest) return true;
    if (
      hasMyfishWascTypePrefix(candidate) &&
      await sha256Bytes(candidate.slice(1)) === expectedDigest
    ) {
      return true;
    }
  }
  return false;
}
