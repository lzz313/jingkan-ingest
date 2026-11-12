import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { IngestConfig } from './env';
import { loadConfig } from './env';
import { moderateItems } from './ingest-client';

export interface ModerateOptions {
  maxRounds?: number;
  limit?: number;
  timeBudgetMs?: number;
  now?: () => number;
  enabled?: boolean;
}

export interface ModerateResult {
  rounds: number;
  checked: number;
  hidden: number;
  remaining: number | null;
  failed: number;
}

function log(message: string): void {
  console.log(`[moderate] ${message}`);
}

/**
 * Drain the Worker's unchecked community queue in batches. Runs after each
 * ingest; stops when the queue is empty, the wall clock runs out, or two
 * consecutive rounds make no progress (which is how a dead AI looks from
 * here — retrying would just burn the workflow's remaining minutes).
 */
export async function moderatePosts(
  config: IngestConfig,
  options: ModerateOptions = {},
): Promise<ModerateResult> {
  const maxRounds = options.maxRounds ?? 6;
  const limit = options.limit ?? 60;
  const timeBudgetMs = options.timeBudgetMs ?? 3 * 60_000;
  const now = options.now ?? Date.now;
  const enabled = options.enabled ?? process.env.AI_MODERATION !== '0';

  if (!enabled) return { rounds: 0, checked: 0, hidden: 0, remaining: null, failed: 0 };

  const startedAt = now();
  let rounds = 0;
  let checked = 0;
  let hidden = 0;
  let failed = 0;
  let remaining: number | null = null;
  let stalled = 0;

  while (rounds < maxRounds) {
    if (now() - startedAt > timeBudgetMs) {
      log(`time budget exhausted after ${rounds} rounds`);
      break;
    }

    const result = await moderateItems(config, limit);
    rounds++;
    checked += result.checked;
    hidden += result.hidden;
    failed += result.failed;

    const previous = remaining;
    remaining = result.remaining;
    log(
      `round ${rounds}: checked ${result.checked}, hidden ${result.hidden}, ` +
        `failed ${result.failed}, remaining ${result.remaining}`,
    );

    if (result.remaining === 0) break;

    // No verdicts written (AI errors) or the queue did not shrink: give the
    // model one more chance, then stop instead of spinning.
    const noProgress = result.checked === 0 || (previous !== null && result.remaining >= previous);
    if (noProgress) {
      stalled++;
      if (stalled >= 2) {
        log('two rounds without progress; stopping');
        break;
      }
    } else {
      stalled = 0;
    }
  }

  return { rounds, checked, hidden, remaining, failed };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const startedAt = Date.now();
  const result = await moderatePosts(config);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`done in ${elapsed}s: ${result.checked} checked, ${result.hidden} hidden`);

  const summary = [
    '### AI moderation',
    '',
    `Rounds: **${result.rounds}**`,
    `Checked: **${result.checked}**`,
    `Hidden: **${result.hidden}**`,
    result.remaining === null ? '' : `Remaining pending: **${result.remaining}**`,
    `Failed: **${result.failed}**`,
    `Elapsed: **${elapsed}s**`,
  ]
    .filter(Boolean)
    .join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  }
}

// Run only when executed directly (tsx); importing it from tests must not
// trigger a network moderation run.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
