import { loadConfig } from './env';
import { runPublisher } from './publisher';
runPublisher(loadConfig(), { repackOnly: true }).catch((error: unknown) => {
  console.error(error); process.exitCode = 1;
});
