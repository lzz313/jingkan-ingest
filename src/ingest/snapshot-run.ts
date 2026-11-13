import { loadConfig } from './env';
import { runSnapshot, SnapshotDeferred } from './snapshot-client';

runSnapshot(loadConfig()).catch((error: unknown) => {
  if (error instanceof SnapshotDeferred) {
    console.log(`[snapshot] deferred: ${error.message}; active snapshot retained`);
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
