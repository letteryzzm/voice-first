import { loadConfig } from "./config.js";
import { VoiceCoachApp } from "./runtime/voiceCoachApp.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = new VoiceCoachApp(config);
  await app.run();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
