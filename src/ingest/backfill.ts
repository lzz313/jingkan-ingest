import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { IngestConfig } from './env';
import { loadConfig } from './env';
import { fetchAdminUntranslated, prewarmTranslations } from './ingest-client';

export interface BackfillOptions {
  maxRounds?: number;
  batchSize?: number;
  timeBudgetMs?: number;
  now?: () => number;
}

export interface BackfillResult {
  rounds: number;
  translated: number;
  remaining: number | null;
}

function log(message: string): void {
  console.log(`[backfill] ${message}`);
}

/**
 * Fill in HN title/body translations that the per-run prewarm could not
 * finish. Runs after each ingest: at most 12 rounds of 20 rows, bounded by an
 * 8-minute wall clock so it fits inside the workflow's timeout.
 */
export async function backfillTranslations(
  config: IngestConfig,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const maxRounds = options.maxRounds ?? 12;
  const batchSize = options.batchSize ?? 20;
  const timeBudgetMs = options.timeBudgetMs ?? 8 * 60_000;
  const now = options.now ?? Date.now;

  if (!config.prewarmTranslations) {
    return { rounds: 0, translated: 0, remaining: null };
  }

  const startedAt = now();
  let rounds = 0;
  let translated = 0;
  let noProgress = 0;
  let remaining: number | null = null;

  while (rounds < maxRounds) {
    if (now() - startedAt > timeBudgetMs) {
      log(`time budget exhausted after ${rounds} rounds`);
      break;
    }

    const pending = await fetchAdminUntranslated(config, batchSize);
    remaining = pending.length;
    if (pending.length === 0) break;

    const titleIds = pending.filter((item) => item.needsTitle).map((item) => item.id);
    const briefIds = pending.filter((item) => item.needsBrief).map((item) => item.id);
    const bodyIds = pending.filter((item) => item.needsBody).map((item) => item.id);

    let roundTranslated = 0;
    // Each field is independent: a brief failure must not block titles or HN bodies.
    for (const [field, ids] of [
      ['title', titleIds],
      ['brief', briefIds],
      ['body', bodyIds],
    ] as const) {
      if (ids.length === 0) continue;
      try {
        const result = await prewarmTranslations(config, ids, field);
        roundTranslated += Object.keys(result.translations).length;
      } catch (error) {
        log(`${field} round failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    rounds++;
    translated += roundTranslated;
    log(
      `round ${rounds}: ${titleIds.length} title, ${briefIds.length} brief, ${bodyIds.length} body -> ${roundTranslated} translated`,
    );

    if (roundTranslated === 0) {
      noProgress++;
      if (noProgress >= 2) {
        log('two rounds without progress; stopping');
        break;
      }
    } else {
      noProgress = 0;
    }
  }

  return { rounds, translated, remaining };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const startedAt = Date.now();
  const result = await backfillTranslations(config);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`done in ${elapsed}s, ${result.translated} translated in ${result.rounds} rounds`);

  const summary = [
    '### Translation backfill',
    '',
    `Rounds: **${result.rounds}**`,
    `Translated: **${result.translated}**`,
    result.remaining === null ? '' : `Last batch pending: **${result.remaining}**`,
  ]
    .filter(Boolean)
    .join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  }
}

// Run only when executed directly (tsx); importing it from tests must not
// trigger a network backfill.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
