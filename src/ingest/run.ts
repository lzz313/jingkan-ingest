import { loadConfig } from './env';
import { runPublisher } from './publisher';
runPublisher(loadConfig(), { forceFetch: process.env.FORCE_FETCH === '1', translationLimit: Math.min(1000, Math.max(60, Number(process.env.TITLE_TRANSLATION_LIMIT) || 60)) }).catch((error: unknown) => {
  console.error(error); process.exitCode = 1;
});
