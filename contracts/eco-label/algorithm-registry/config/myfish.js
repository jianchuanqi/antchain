const rest = process.env.ANTCHAIN_REST_URL
  ? {
    bizid: process.env.ANTCHAIN_BIZ_ID,
    restUrl: process.env.ANTCHAIN_REST_URL,
    accessId: process.env.ANTCHAIN_ACCESS_ID,
    accessSecret: process.env.ANTCHAIN_ACCESS_SECRET,
    account: process.env.ANTCHAIN_ACCOUNT,
    accountPrivateKey: process.env.ANTCHAIN_ACCOUNT_PRIVATE_KEY,
    accountPrivateKeyPassword:
      process.env.ANTCHAIN_ACCOUNT_PRIVATE_KEY_PASSWORD || "",
    kmsId: process.env.ANTCHAIN_KMS_ID,
    tenantId: process.env.ANTCHAIN_TENANT_ID,
  }
  : undefined;

module.exports = {
  contract: {
    type: "assemblyscript",
    name: process.env.ECO_ALGORITHM_REGISTRY_CONTRACT ||
      "EDDLAlgorithmRegistry",
    version: 1,
    tee: false,
  },
  ...(rest ? { rest } : {}),
};
