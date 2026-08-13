function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; no request was sent.`);
  return value;
}

async function main() {
  const restUrl = required('ANTCHAIN_REST_URL');
  const response = await fetch(new URL('/api/contract/chainCall', restUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({
      accessId: required('ANTCHAIN_ACCESS_ID'),
      bizid: required('ANTCHAIN_BIZ_ID'),
      hash: required('ANTCHAIN_LEGACY_TRANSACTION_HASH'),
      method: 'QUERYTRANSACTION',
      token: required('ANTCHAIN_SESSION_TOKEN'),
    }),
  });
  if (!response.ok) throw new Error(`AntChain HTTP ${response.status}`);
  const result = await response.json();
  console.log(`AntChain transaction query accepted=${result?.success === true}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Legacy query example failed.');
  process.exitCode = 1;
});
