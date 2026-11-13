import { createHash } from 'node:crypto';
import { beijingDate, type DailyDigest, type DailyEntry } from '../shared/daily';
import { SOURCE_IDS, type FeedItem } from '../shared/types';
import { firstSentences, stripHtml, stripMarkdown } from '../shared/html';
import { isUsableTranslation } from '../shared/translation';
import { sourceNeedsTitleTranslation } from '../shared/sources';
import type { IngestConfig } from './env';
import { call } from './snapshot-client';

function entryFor(item: FeedItem): DailyEntry {
  const title = sourceNeedsTitleTranslation(item.source) && isUsableTranslation(item.title, item.titleZh) ? item.titleZh! : item.title;
  const summary = item.source === 'hn' && isUsableTranslation(item.body, item.bodyZh) ? item.bodyZh :
    isUsableTranslation(item.brief, item.briefZh) ? item.briefZh : item.brief || item.body;
  return {
    id: item.id, source: item.source, title: stripHtml(title).slice(0, 320),
    summary: firstSentences(stripMarkdown(stripHtml(summary)), 220), url: item.url,
    author: (item.source === 'x' && item.authorHandle ? '@' + item.authorHandle : item.author)?.slice(0, 200) ?? null,
    publishedAt: item.publishedAt,
    reason: item.isHot ? '来源均衡选入；已达到该来源的活跃度门槛。' : '来源均衡选入；在同来源中按活跃度和发布时间排序。',
  };
}

/** Build independent, bounded archives from visible records; never archive pending/hidden items. */
export function buildDailyDigests(items: FeedItem[], now = Date.now()): DailyDigest[] {
  const days = new Map<string, FeedItem[]>();
  const today = beijingDate(now);
  for (const item of items) {
    if (item.hidden || !Number.isFinite(item.publishedAt) || !/^https?:\/\//i.test(item.url)) continue;
    const day = beijingDate(item.publishedAt);
    if (day > today) continue;
    const list = days.get(day) ?? [];
    list.push(item);
    days.set(day, list);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => {
    const sources: DailyDigest['sources'] = {};
    const groups = new Map<string, FeedItem[]>();
    for (const source of SOURCE_IDS) {
      const group = list.filter((item) => item.source === source).sort((a, b) =>
        Number(b.isHot) - Number(a.isHot) || b.hotScore - a.hotScore || b.publishedAt - a.publishedAt || a.id.localeCompare(b.id));
      if (group.length) { sources[source] = group.length; groups.set(source, group.slice(0, 2)); }
    }
    // Rotate the source receiving the extra slot so a large source cannot dominate.
    const offset = Math.floor(Date.parse(day + 'T00:00:00Z') / 86400000) % SOURCE_IDS.length;
    const order = [...SOURCE_IDS.slice(offset), ...SOURCE_IDS.slice(0, offset)];
    const selected: FeedItem[] = [];
    for (let round = 0; round < 2; round++) {
      for (const source of order) {
        const item = groups.get(source)?.[round];
        if (item && selected.length < 12) selected.push(item);
      }
    }
    return { version: 1, day, total: list.length, sources, entries: selected.map(entryFor) };
  });
}

export async function publishDailyDigests(config: IngestConfig, items: FeedItem[], token: string, snapshotId: string): Promise<number> {
  const digests = buildDailyDigests(items);
  const hashes: Record<string, string> = {};
  for (const year of new Set(digests.map((digest) => digest.day.slice(0, 4)))) {
    const index = await (await call(config, `/api/admin/daily?year=${year}`)).json() as { hashes: Record<string, string> };
    Object.assign(hashes, index.hashes);
  }
  let updated = 0;
  const yesterday = beijingDate(Date.now() - 86400000);
  for (const digest of digests) {
    // Completed historical pages stay intact as the rolling timeline expires.
    if (hashes[digest.day] && digest.day < yesterday) continue;
    const body = JSON.stringify(digest);
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (hashes[digest.day] === sha256) continue;
    await call(config, '/api/admin/daily/' + digest.day, {
      method: 'PUT', body, headers: {
        'content-type': 'application/json', 'x-content-sha256': sha256,
        'x-publisher-lease': token, 'x-expected-snapshot': snapshotId,
      },
    });
    updated++;
  }
  return updated;
}
