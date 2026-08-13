import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const root = dirname(dirname(fromFileUrl(import.meta.url)));
const scenarios = JSON.parse(
  await Deno.readTextFile(join(root, "conformance/scenarios.json")),
) as {
  schemaVersion: string;
  contract: string;
  scenarios: Array<{ id: string; name: string; security: boolean }>;
};
const command = new Deno.Command("bash", {
  args: [join(root, "test-contract.sh")],
  cwd: dirname(dirname(root)),
  stdout: "piped",
  stderr: "piped",
});
const result = await command.output();
const output = `${new TextDecoder().decode(result.stdout)}\n${
  new TextDecoder().decode(result.stderr)
}`;
if (!result.success) {
  throw new Error(`EVM scenario execution failed:\n${output}`);
}
for (const scenario of scenarios.scenarios) {
  if (!output.includes(`${scenario.name} ... ok`)) {
    throw new Error(
      `Scenario result is missing: ${scenario.id} ${scenario.name}`,
    );
  }
}
const total = scenarios.scenarios.length;
const security = scenarios.scenarios.filter((item) => item.security).length;
const report = {
  schemaVersion: "eco-design-label-evm-accuracy-report/v1",
  contract: scenarios.contract,
  sourceScenarioSchema: scenarios.schemaVersion,
  measurement:
    "complete mandatory assertion agreement with frozen automated scenarios",
  total,
  passed: total,
  failed: 0,
  accuracyPercent: 100,
  securityTotal: security,
  securityPassed: security,
  securityAccuracyPercent: 100,
  scientificRatingAccuracyClaimed: false,
  scenarios: scenarios.scenarios.map((item) => ({ ...item, outcome: "PASS" })),
};
await Deno.writeTextFile(
  join(root, "dist/accuracy-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
const markdown = `# EcoDesignLabelRegistryV1 automated scenario agreement\n\n` +
  `- Overall: **${total}/${total} = 100%**\n` +
  `- Security invariants: **${security}/${security} = 100%**\n` +
  `- Measurement: complete mandatory assertion agreement with the frozen automated scenarios.\n` +
  `- This is not a claim about scientific rating validity.\n\n` +
  `| ID | Scenario | Security | Outcome |\n|---|---|---:|---|\n` +
  scenarios.scenarios.map((item) =>
    `| ${item.id} | ${item.name} | ${item.security ? "yes" : "no"} | PASS |`
  ).join("\n") + "\n";
await Deno.writeTextFile(join(root, "dist/accuracy-report.md"), markdown);
console.log(
  JSON.stringify(
    { total, passed: total, accuracyPercent: 100, security },
    null,
    2,
  ),
);
