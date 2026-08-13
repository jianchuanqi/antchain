const { randomUUID } = require('node:crypto');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; no request was sent.`);
  return value;
}

async function main() {
  const restUrl = required('ANTCHAIN_REST_URL');
  const response = await fetch(new URL('/api/contract/chainCallForBiz', restUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({
      accessId: required('ANTCHAIN_ACCESS_ID'),
      account: required('ANTCHAIN_ACCOUNT'),
      bizid: required('ANTCHAIN_BIZ_ID'),
      content: required('ANTCHAIN_LEGACY_DEPOSIT_CONTENT'),
      gas: 0,
      method: 'DEPOSIT',
      mykmsKeyId: required('ANTCHAIN_KMS_ID'),
      orderId: randomUUID(),
      tenantid: required('ANTCHAIN_TENANT_ID'),
      token: required('ANTCHAIN_SESSION_TOKEN'),
      withGasHold: false,
    }),
  });
  if (!response.ok) throw new Error(`AntChain HTTP ${response.status}`);
  const result = await response.json();
  console.log(`AntChain deposit accepted=${result?.success === true}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Legacy deposit example failed.');
  process.exitCode = 1;
});
