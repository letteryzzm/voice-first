import { loadConfig } from "./config.js";
import { createProductionVoiceCoachApp } from "./runtime/createProductionApp.js";
import { runPreflight } from "./runtime/preflight.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await runPreflight(config);
  const app = createProductionVoiceCoachApp(config);
  await app.run();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
