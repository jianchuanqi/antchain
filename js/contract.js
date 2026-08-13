const { randomUUID } = require('node:crypto');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; no request was sent.`);
  return value;
}

function configuration() {
  return {
    restUrl: required('ANTCHAIN_REST_URL'),
    accessId: required('ANTCHAIN_ACCESS_ID'),
    account: required('ANTCHAIN_ACCOUNT'),
    bizId: required('ANTCHAIN_BIZ_ID'),
    kmsId: required('ANTCHAIN_KMS_ID'),
    tenantId: required('ANTCHAIN_TENANT_ID'),
    contractName: required('ANTCHAIN_LEGACY_CONTRACT_NAME'),
    token: required('ANTCHAIN_SESSION_TOKEN'),
  };
}

async function callWasmContract(config, methodSignature, values, outTypes, isLocalTransaction) {
  const response = await fetch(new URL('/api/contract/chainCallForBiz', config.restUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({
      accessId: config.accessId,
      account: config.account,
      bizid: config.bizId,
      gas: 0,
      inputParamListStr: JSON.stringify(values),
      method: 'CALLWASMCONTRACTASYNC',
      methodSignature,
      isLocalTransaction,
      mykmsKeyId: config.kmsId,
      orderId: randomUUID(),
      outTypes,
      tenantid: config.tenantId,
      token: config.token,
      withGasHold: false,
      contractName: config.contractName,
    }),
  });
  if (!response.ok) throw new Error(`AntChain HTTP ${response.status}`);
  const result = await response.json();
  console.log(`AntChain ${methodSignature} accepted=${result?.success === true}`);
  return result;
}

async function main() {
  const config = configuration();
  await callWasmContract(config, 'GetName()', [], '[string]', true);
  await callWasmContract(
    config,
    'setName(string)',
    [required('ANTCHAIN_LEGACY_NEW_NAME')],
    '[]',
    false,
  );
  await callWasmContract(config, 'GetName()', [], '[string]', true);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Legacy contract example failed.');
  process.exitCode = 1;
});
