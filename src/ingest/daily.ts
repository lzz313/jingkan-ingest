import { createHash } from 'node:crypto';
import { beijingDate, clipDailyText, isDailyDigest, isoWeekOfDay, type DailyDigest, type DailyEntry } from '../shared/daily';
import type { FeedItem, SourceId } from '../shared/types';
import { firstSentences, stripHtml, stripMarkdown } from '../shared/html';
import { formatCompactNumber } from '../shared/numbers';
import { isChineseBrief, isUsableTranslation } from '../shared/translation';
import { SOURCES, sourceNeedsTitleTranslation } from '../shared/sources';
import { itemTopics, topicPath, type TopicId } from '../shared/topics';
import type { IngestConfig } from './env';
import { call } from './snapshot-client';

const DAILY_LIMIT = 12;
const PER_SOURCE_LIMIT = 2;

/**
 * Editorial prior on top of engagement. Curated sources (a personal blog,
 * first-party AI posts, papers) rarely have a hot score, but they are strong
 * daily reads; community sources get their quality from the engagement score.
 */
const SOURCE_QUALITY: Partial<Record<SourceId, number>> = {
  simonw: 30,
  'google-ai': 28,
  'hf-papers': 24,
  hn: 14,
  github: 12,
  v2ex: 10,
  linuxdo: 10,
  nodeseek: 10,
  reddit: 8,
  producthunt: 8,
  x: 5,
};

/**
 * A Tech Twitter canonical URL points at the aggregator's own page, not an
 * article the reader can open as the source.
 */
function isExternalArticleUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    return host !== 'techtwitter.com' && !host.endsWith('.techtwitter.com');
  } catch {
    return false;
  }
}

/**
 * Quality-first score: engagement dominates, substance and editorial source
 * priors break ties, and the per-source cap below supplies diversity.
 */
export function dailyQuality(item: FeedItem): number {
  const text = `${item.title}\n${item.body ?? ''}`;
  const link = /https?:\/\//i.test(text) || isExternalArticleUrl(item.extra.canonicalUrl) ? 5 : 0;
  const substance = Math.min(6, Math.floor((item.body?.length ?? 0) / 400));
  return (
    Math.max(0, item.hotScore) * 0.55 +
    (SOURCE_QUALITY[item.source] ?? 0) +
    (item.isHot ? 8 : 0) +
    link +
    substance
  );
}

function finiteMetric(value: number | string | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Specific, data-backed selection reason so daily archive entries carry real
 * signals instead of repeating the same boilerplate line twelve times.
 */
export function dailyReason(item: FeedItem): string {
  const parts: string[] = [];
  const metrics = item.metrics ?? {};
  const extra = item.extra ?? {};
  const addMetric = (value: number | string | undefined, format: (formatted: string) => string) => {
    const number = finiteMetric(value);
    if (number !== null) parts.push(format(formatCompactNumber(number)));
  };

  switch (item.source) {
    case 'hn':
      addMetric(metrics.points, (n) => `${n} 分`);
      addMetric(metrics.comments, (n) => `${n} 评论`);
      break;
    case 'github':
      addMetric(metrics.starsToday, (n) => `今日 +${n} stars`);
      addMetric(metrics.starsTotal, (n) => `${n} stars`);
      if (typeof extra.lang === 'string' && extra.lang.trim()) parts.push(extra.lang.trim());
      break;
    case 'x':
      addMetric(metrics.views, (n) => `浏览 ${n}`);
      addMetric(metrics.likes, (n) => `赞 ${n}`);
      addMetric(metrics.retweets, (n) => `转发 ${n}`);
      break;
    case 'v2ex':
      addMetric(metrics.replies, (n) => `${n} 回复`);
      if (typeof extra.nodeTitle === 'string' && extra.nodeTitle.trim()) parts.push(extra.nodeTitle.trim());
      break;
    case 'linuxdo':
      addMetric(metrics.posts, (n) => `${n} 帖`);
      if (typeof extra.category === 'string' && extra.category.trim()) parts.push(extra.category.trim());
      break;
    case 'nodeseek':
      addMetric(metrics.comments, (n) => `${n} 回复`);
      addMetric(metrics.views, (n) => `浏览 ${n}`);
      break;
    case 'hf-papers':
      addMetric(metrics.upvotes, (n) => `${n} 赞同`);
      addMetric(metrics.comments, (n) => `${n} 讨论`);
      break;
    case 'reddit':
      if (typeof extra.subreddit === 'string' && extra.subreddit.trim()) parts.push(`r/${extra.subreddit.trim()}`);
      break;
    case 'google-ai':
      parts.push(typeof extra.category === 'string' && extra.category.trim() ? `官方博客 · ${extra.category.trim()}` : 'Google AI 官方发布');
      break;
    case 'simonw':
      parts.push('独立技术专栏精选');
      break;
    case 'producthunt':
      parts.push('每日科技新品');
      break;
  }

  if (item.related?.length) {
    const others = item.related
      .map((entry) => SOURCES[entry.source]?.shortName ?? entry.source)
      .slice(0, 3)
      .join(' / ');
    parts.push(`同题另有 ${others} 讨论`);
  }

  if (!parts.length) {
    parts.push(item.isHot ? '达到该来源活跃热度门槛' : `${SOURCES[item.source].shortName} 当日质量精选`);
  } else if (item.isHot && parts.length === 1 && (item.source === 'reddit' || item.source === 'producthunt')) {
    parts.push('达到活跃热度门槛');
  }

  return clipDailyText(`质量优先 · ${parts.join(' · ')}`, 190);
}

function entryFor(item: FeedItem): DailyEntry {
  const rawTitle = stripHtml(item.title).slice(0, 320);
  const translatedTitle =
    sourceNeedsTitleTranslation(item.source) &&
    isUsableTranslation(item.title, item.titleZh) &&
    item.titleZh !== item.title
      ? stripHtml(item.titleZh!).slice(0, 320)
      : '';
  const title = translatedTitle || rawTitle;
  const originalTitle = translatedTitle && rawTitle && translatedTitle !== rawTitle ? rawTitle : undefined;
  const briefZh = isChineseBrief(item.briefZh) ? item.briefZh : null;
  // HN and X bodies are English; the translated body is the archive summary.
  const summary = (item.source === 'hn' || item.source === 'x') && isUsableTranslation(item.body, item.bodyZh)
    ? item.bodyZh
    : briefZh || item.brief || item.body;
  return {
    id: item.id, source: item.source, title,
    ...(originalTitle ? { originalTitle } : {}),
    summary: firstSentences(stripMarkdown(stripHtml(summary)), 220), url: item.url,
    author: (item.source === 'x' && item.authorHandle ? '@' + item.authorHandle : item.author)?.slice(0, 200) ?? null,
    publishedAt: item.publishedAt,
    reason: dailyReason(item),
  };
}

/** Build independent, bounded archives from visible records; never archive pending/hidden items. */
export function buildDailyDigests(items: FeedItem[], now = Date.now()): DailyDigest[] {
  const days = new Map<string, FeedItem[]>();
  const today = beijingDate(now);
  for (const item of items) {
    if (item.hidden || item.clusterOf || !Number.isFinite(item.publishedAt) || !/^https?:\/\//i.test(item.url)) continue;
    const day = beijingDate(item.publishedAt);
    if (day > today) continue;
    const list = days.get(day) ?? [];
    list.push(item);
    days.set(day, list);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([day, list]) => {
    const sources: DailyDigest['sources'] = {};
    for (const item of list) sources[item.source] = (sources[item.source] ?? 0) + 1;

    // Rank the whole day by quality, then enforce source diversity while
    // filling. Two per source is also the archive validator's hard limit.
    const selected: FeedItem[] = [];
    const perSource = new Map<SourceId, number>();
    const candidates = list
      .filter((item) => item.hotEligible !== false)
      .sort((a, b) =>
        dailyQuality(b) - dailyQuality(a) ||
        b.publishedAt - a.publishedAt ||
        a.id.localeCompare(b.id));
    for (const item of candidates) {
      if (selected.length >= DAILY_LIMIT) break;
      const count = perSource.get(item.source) ?? 0;
      if (count >= PER_SOURCE_LIMIT) continue;
      selected.push(item);
      perSource.set(item.source, count + 1);
    }
    const digest: DailyDigest = { version: 1, day, total: list.length, sources, entries: selected.map(entryFor) };
    // A day whose only items fail the hot gate (for example a joke-only X
    // batch) has no valid entries; the archive endpoint rejects it with 400,
    // so no digest is published at all.
    return digest.entries.length > 0 && isDailyDigest(digest) ? [digest] : [];
  });
}

const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** Notify IndexNow (Bing / Yandex / ChatGPT Search) when public archive pages change. */
export async function notifyIndexNow(
  config: IngestConfig,
  updatedDays: string[],
  updatedSources: SourceId[] = [],
  updatedTopics: TopicId[] = [],
): Promise<boolean> {
  const key = config.indexNowKey?.trim();
  if (!key || !/^[a-zA-Z0-9-]{8,128}$/.test(key) || updatedDays.length === 0) return false;
  let origin: URL;
  try {
    origin = new URL(config.baseUrl);
  } catch {
    return false;
  }
  if (origin.protocol !== 'https:' || origin.hostname === 'localhost' || origin.hostname === '127.0.0.1') {
    return false;
  }
  const years = [...new Set(updatedDays.map((day) => day.slice(0, 4)).filter((year) => /^\d{4}$/.test(year)))];
  const weeks = [...new Set(updatedDays.map((day) => isoWeekOfDay(day)))];
  const sources = [...new Set(updatedSources)];
  const topics = [...new Set(updatedTopics)];
  const urlList = [
    `${origin.origin}/`,
    `${origin.origin}/hot`,
    `${origin.origin}/daily`,
    `${origin.origin}/weekly`,
    ...years.map((year) => `${origin.origin}/daily/${year}`),
    ...weeks.map((week) => `${origin.origin}/weekly/${week}`),
    ...updatedDays.map((day) => `${origin.origin}/daily/${day}`),
    ...sources.map((source) => `${origin.origin}/source/${source}`),
    ...(topics.length > 0 ? [`${origin.origin}/topic`, ...topics.map((topic) => `${origin.origin}${topicPath(topic)}`)] : []),
  ];
  try {
    const response = await fetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: origin.hostname,
        key,
        keyLocation: `${origin.origin}/${key}.txt`,
        urlList,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      console.warn(`[indexnow] HTTP ${response.status} for ${urlList.length} urls`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[indexnow] deferred:', String(error));
    return false;
  }
}

export async function publishDailyDigests(config: IngestConfig, items: FeedItem[], token: string, snapshotId: string): Promise<number> {
  const digests = buildDailyDigests(items);
  const hashes: Record<string, string> = {};
  for (const year of new Set(digests.map((digest) => digest.day.slice(0, 4)))) {
    const index = await (await call(config, `/api/admin/daily?year=${year}`)).json() as { hashes: Record<string, string> };
    Object.assign(hashes, index.hashes);
  }
  const updatedDays: string[] = [];
  const updatedSources = new Set<SourceId>();
  const updatedTopics = new Set<TopicId>();
  const yesterday = beijingDate(Date.now() - 86400000);
  for (const digest of digests) {
    const day = digest.day;
    if (!isDailyDigest(digest)) {
      console.warn(`[daily] skipped invalid archive for ${day}`);
      continue;
    }
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
    updatedDays.push(digest.day);
    for (const source of Object.keys(digest.sources) as SourceId[]) {
      updatedSources.add(source);
    }
  }
  if (updatedDays.length > 0) {
    const updatedDaySet = new Set(updatedDays);
    for (const item of items) {
      if (item.hidden || item.clusterOf || !Number.isFinite(item.publishedAt)) continue;
      if (!updatedDaySet.has(beijingDate(item.publishedAt))) continue;
      for (const topic of itemTopics(item)) updatedTopics.add(topic);
    }
    await notifyIndexNow(config, updatedDays, [...updatedSources], [...updatedTopics]);
  }
  return updatedDays.length;
}
