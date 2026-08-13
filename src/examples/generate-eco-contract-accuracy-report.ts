import {
  formatAccuracyReportMarkdown,
  generateAccuracyReport,
} from "../eco/contracts/conformance.ts";

const report = await generateAccuracyReport();
const markdown = formatAccuracyReportMarkdown(report);

const outputIndex = Deno.args.indexOf("--output");
if (outputIndex >= 0) {
  const output = Deno.args[outputIndex + 1];
  if (!output) throw new Error("--output requires a file path");
  await Deno.writeTextFile(output, markdown);
} else {
  console.log(markdown);
}

if (!report.thresholdMet || !report.securityTargetMet) Deno.exit(1);
