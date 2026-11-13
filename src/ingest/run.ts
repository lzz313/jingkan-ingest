import { loadConfig } from './env';
import { runPublisher } from './publisher';
runPublisher(loadConfig(), { forceFetch: process.env.FORCE_FETCH === '1' }).catch((error: unknown) => {
  console.error(error); process.exitCode = 1;
});
