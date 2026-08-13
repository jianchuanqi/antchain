import { resolveAntChainLiveConfig } from "../eco/adapters/antchain-live-config.ts";

const resolution = await resolveAntChainLiveConfig();
console.log(JSON.stringify(resolution.report, null, 2));
if (!resolution.report.ready) Deno.exit(2);
