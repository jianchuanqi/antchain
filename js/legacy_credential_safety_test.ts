const legacySources = [
  "dataSource.java",
  "requestProcessData.java",
  "getToken.js",
  "contract.js",
  "datapush.js",
  "dataread.js",
  "../src/examples/privacy-example.ts",
] as const;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertContains(
  source: string,
  expected: string,
  fileName: string,
): void {
  assert(
    source.includes(expected),
    `${fileName} must require ${expected} at runtime`,
  );
}

Deno.test("legacy examples do not contain tracked credentials or response logging", async () => {
  const sourceByName = new Map<string, string>();
  for (const fileName of legacySources) {
    sourceByName.set(
      fileName,
      await Deno.readTextFile(new URL(fileName, import.meta.url)),
    );
  }

  const combinedSource = [...sourceByName.values()].join("\n");
  const forbiddenPatterns: Array<[RegExp, string]> = [
    [/https?:\/\//i, "literal remote URL"],
    [
      /\.addHeader\(\s*['"]Authorization['"]\s*,\s*['"]Bearer\s+[^'"]+/i,
      "literal bearer credential",
    ],
    [
      /\.addHeader\(\s*['"]x_key['"]\s*,\s*['"][^'"]+['"]\s*\)/i,
      "literal x_key credential",
    ],
    [
      /const\s+accessId\s*=\s*['"][^'"]+['"]/,
      "literal REST access identifier",
    ],
    [
      /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]*/,
      "literal JWT or session token",
    ],
    [
      /80cd5f70-a6fa-4b64-97f1-7b22c2d3d88e/,
      "tracked research account identifier",
    ],
    [
      /path\.resolve\(\s*__dirname\s*,/,
      "repository-relative signing-key path",
    ],
    [
      /console\.(?:log|error)\([^;\n]*(?:responseText|Raw response|,\s*response\b)/i,
      "response body or token logging",
    ],
  ];

  for (const [pattern, description] of forbiddenPatterns) {
    assert(!pattern.test(combinedSource), `Found forbidden ${description}`);
  }

  const dataSource = sourceByName.get("dataSource.java") ?? "";
  assertContains(
    dataSource,
    "ANTCHAIN_LEGACY_EMBEDDING_API_URL",
    "dataSource.java",
  );
  assertContains(dataSource, "ANTCHAIN_LEGACY_API_X_KEY", "dataSource.java");
  assertContains(
    dataSource,
    "requireBearerAuthorization(token)",
    "dataSource.java",
  );

  const processData = sourceByName.get("requestProcessData.java") ?? "";
  assertContains(
    processData,
    "ANTCHAIN_LEGACY_PROCESS_DATA_API_URL",
    "requestProcessData.java",
  );
  assertContains(
    processData,
    "ANTCHAIN_LEGACY_API_X_KEY",
    "requestProcessData.java",
  );
  assertContains(
    processData,
    "requireBearerAuthorization(token)",
    "requestProcessData.java",
  );

  const getToken = sourceByName.get("getToken.js") ?? "";
  assertContains(
    getToken,
    "ANTCHAIN_REST_ACCESS_SECRET_FILE",
    "getToken.js",
  );
  assertContains(getToken, "ANTCHAIN_REST_ACCESS_ID", "getToken.js");
  assertContains(getToken, "ANTCHAIN_REST_URL", "getToken.js");
  assertContains(getToken, "process.exitCode = 1", "getToken.js");

  for (const fileName of ["contract.js", "datapush.js", "dataread.js"]) {
    const source = sourceByName.get(fileName) ?? "";
    assertContains(source, "ANTCHAIN_REST_URL", fileName);
    assertContains(source, "ANTCHAIN_ACCESS_ID", fileName);
    assertContains(source, "ANTCHAIN_SESSION_TOKEN", fileName);
    assertContains(source, "process.exitCode = 1", fileName);
  }

  const privacyExample =
    sourceByName.get("../src/examples/privacy-example.ts") ?? "";
  assertContains(
    privacyExample,
    "defaultConfig.blockchain.accessId",
    "privacy-example.ts",
  );
});
