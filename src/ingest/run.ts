import { appendFileSync } from 'node:fs';
import type { IngestStatus, NormalizedItem, SourceId } from '../shared/types';
import { SOURCES } from '../shared/sources';
import { extractImages } from '../shared/html';
import { shouldHideItem } from '../shared/spam';
import { fetchGithub } from './adapters/github';
import { fetchHn } from './adapters/hn';
import { fetchLinuxDo } from './adapters/linuxdo';
import { fetchNodeseek } from './adapters/nodeseek';
import { fetchReddit } from './adapters/reddit';
import { fetchV2ex } from './adapters/v2ex';
import { fetchX } from './adapters/x';
import { loadConfig } from './env';
import {
  fetchAdminRecent,
  postIngest,
  postMaintenance,
  prewarmTranslations,
} from './ingest-client';
import { normalizeItem } from '../shared/normalize';

interface Adapter {
  source: SourceId;
  run: () => Promise<NormalizedItem[]>;
}

const ADAPTERS: Adapter[] = [
  { source: 'x', run: fetchX },
  { source: 'v2ex', run: fetchV2ex },
  { source: 'nodeseek', run: fetchNodeseek },
  { source: 'linuxdo', run: fetchLinuxDo },
  { source: 'hn', run: fetchHn },
  { source: 'github', run: fetchGithub },
  { source: 'reddit', run: fetchReddit },
];

function log(message: string): void {
  console.log(`[ingest] ${message}`);
}

function prepare(raw: NormalizedItem[], now: number): NormalizedItem[] {
  const byId = new Map<string, NormalizedItem>();
  for (const item of raw) {
    try {
      const normalized = normalizeItem(item, now);
      byId.set(`${normalized.source}:${normalized.externalId}`, normalized);
    } catch (error) {
      log(`skip invalid item: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...byId.values()];
}

async function maintain(config: ReturnType<typeof loadConfig>): Promise<void> {
  try {
    const recent = await fetchAdminRecent(config, 200);
    const patches = [];
    for (const item of recent) {
      const hidden = shouldHideItem(item);
      const images = item.images.length > 0 ? item.images : extractImages(item.body, item.url);
      const imagesChanged =
        images.length !== item.images.length || images.some((url, i) => url !== item.images[i]);
      if (hidden !== item.hidden || imagesChanged) {
        patches.push({
          id: item.id,
          ...(hidden !== item.hidden ? { hidden } : {}),
          ...(imagesChanged ? { images } : {}),
        });
      }
    }
    const updated = await postMaintenance(config, patches);
    log(`maintenance: ${patches.length} patches, ${updated} updated`);
  } catch (error) {
    log(`maintenance skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const startedAt = Date.now();
  const results = await Promise.allSettled(ADAPTERS.map((adapter) => adapter.run()));
  const status: Partial<Record<SourceId, IngestStatus>> = {};
  const successfulItems: NormalizedItem[] = [];
  let failed = 0;

  for (const [index, result] of results.entries()) {
    const adapter = ADAPTERS[index]!;
    if (result.status === 'rejected') {
      failed++;
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      status[adapter.source] = { ok: false, error: message.slice(0, 300) };
      log(`${SOURCES[adapter.source].name} failed: ${message}`);
      continue;
    }

    const prepared = prepare(result.value, startedAt);
    status[adapter.source] = { ok: true, count: prepared.length };
    successfulItems.push(...prepared);
    log(`${SOURCES[adapter.source].name}: ${prepared.length} items`);
  }

  let upserted = 0;
  if (Object.keys(status).length > 0) {
    try {
      const response = await postIngest(config, successfulItems, {
        partial: false,
        sourceStatus: status,
      });
      upserted = response.upserted;
      log(`ingest: ${upserted} upserted of ${successfulItems.length} items`);
    } catch (error) {
      log(`ingest write failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
  }

  if (config.prewarmTranslations) {
    const pendingTitles = successfulItems.filter(
      (item) => (item.source === 'hn' || item.source === 'reddit') && !item.titleZh,
    );
    const hnTitles = pendingTitles.filter((item) => item.source === 'hn');
    const redditTitles = pendingTitles.filter((item) => item.source === 'reddit');
    // Alternate sources so a busy HN front page cannot starve Reddit titles.
    const titleIds: string[] = [];
    for (let index = 0; index < Math.max(hnTitles.length, redditTitles.length); index++) {
      for (const pool of [hnTitles, redditTitles]) {
        const item = pool[index];
        if (item && titleIds.length < 20) titleIds.push(`${item.source}:${item.externalId}`);
      }
    }
    const githubIds = successfulItems
      .filter((item) => item.source === 'github' && !item.briefZh)
      .slice(0, 20)
      .map((item) => `${item.source}:${item.externalId}`);

    for (const [field, ids] of [
      ['title', titleIds],
      ['body', githubIds],
    ] as const) {
      if (ids.length === 0) continue;
      try {
        const result = await prewarmTranslations(config, ids, field);
        log(`translation prewarm (${field}): ${Object.keys(result.translations).length} translated`);
      } catch (error) {
        log(`translation prewarm skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  await maintain(config);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`done in ${elapsed}s, ${failed} source(s) failed`);

  const summary = [
    '| source | status | items |',
    '| --- | --- | --- |',
    ...ADAPTERS.map((adapter) => {
      const item = status[adapter.source];
      const label = item?.ok ? 'ok' : 'failed';
      return `| ${SOURCES[adapter.source].name} | ${label} | ${item?.count ?? 0} |`;
    }),
    '',
    `Upserted: **${upserted}**`,
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  }

  if (failed === ADAPTERS.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
