/**
 * On-demand & scheduled daily ADC parity probe for `gemini-decision-1`
 * (`npm run brain:check-adc -w @warehouse/site`).
 *
 * Checks whether Google Cloud Application Default Credentials (Vertex AI endpoint or
 * OAuth2 ADC Bearer token on `generativelanguage.googleapis.com/v1beta/decisions`)
 * are now enabled for `gemini-decision-1`, allowing the Secret Manager API key
 * exception (`gemini-decisions-api-key`) to be retired.
 */
import { probeDecisionsAdcSupport } from './brain.js';

async function main() {
  const res = await probeDecisionsAdcSupport();
  console.log(JSON.stringify(res, null, 2));
  if (res.supported) {
    console.log(
      `\n✅ ADC IS ENABLED (${res.mode})! @warehouse/site will automatically use ADC instead of GEMINI_DECISIONS_API_KEY. You can now remove the gemini-decisions-api-key secret version.`,
    );
  } else {
    console.log(
      `\n⏳ ADC not yet enabled for gemini-decision-1. Keeping GEMINI_DECISIONS_API_KEY exception active (next automatic shard check in 24h).`,
    );
  }
}

main().catch((err) => {
  console.error('ADC check failed:', err);
  process.exitCode = 1;
});
