import { resolveAntChainEvmReadiness } from "../eco/adapters/antchain-evm-readiness.ts";

const report = await resolveAntChainEvmReadiness();
console.log(JSON.stringify(report, null, 2));
Deno.exit(report.serviceRuntimeReady ? 0 : 2);
