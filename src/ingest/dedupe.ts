import { hashText, stripHtml } from '../shared/html';
import type { FeedItem } from '../shared/types';
import type { DedupeConfig, IngestConfig } from './env';
import { createEmbedder } from './embed-client';
import type { DedupeMarker, GeneratorState, StoredItem } from './state';

const ALGORITHM_VERSION = 'nodeseek-dedupe-v1';
const DAY_MS = 86400000;
const BODY_CHARS = 300;
const MIN_BODY_CHARS = 20;
const SHORT_TITLE_CHARS = 8;
/** Tokens that appear in nearly every post and would drown the lexical signal. */
const SECONDARY_TOKENS = new Set([
  'www', 'com', 'cn', 'net', 'org', 'io', 'co',
  'http', 'https', 'html', 'htm', 'php', 'js', 'css',
  'api', 'app', 'cdn', 'img', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
  'vps', 'the', 'and', 'for', 'with', 'from', 'this', 'that',
]);
const TRACKING_PARAM = /^(?:utm_.+|ref|aff|spm|from|share|share_token)$/i;

export interface DedupeRunResult {
  checked: number;
  duplicates: number;
  skipped: number;
  dryRun: boolean;
  reset: boolean;
}

interface Feature {
  title: string;
  body: string;
  titleTokens: Set<string>;
  bodyTokens: Set<string>;
  latinTokens: Set<string>;
  urls: Set<string>;
}

interface Candidate {
  record: StoredItem;
  score: number;
}

/** Settings that can change a verdict; count/timeout knobs deliberately excluded. */
export function dedupeFingerprint(config: DedupeConfig): string {
  return hashText(JSON.stringify([
    ALGORITHM_VERSION,
    config.windowDays,
    config.lexicalThreshold,
    config.cosineThreshold,
    config.textChars,
  ]));
}

function isCjk(character: string): boolean {
  return /[㐀-鿿豈-﫿]/.test(character);
}

function normalizeText(value: string | null | undefined): string {
  return stripHtml(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‍﻿]/g, '')
    .replace(/https?:\/\/[^\s"'<>()]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** External links from a post body, without tracking parameters or host noise. */
function externalUrls(value: string | null | undefined): Set<string> {
  const urls = new Set<string>();
  for (const match of (value ?? '').matchAll(/https?:\/\/[^\s"'<>()]+/gi)) {
    const raw = match[0].replace(/[),.;!?，。；！？]+$/, '');
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
      if (hostname === 'nodeseek.com' || hostname.endsWith('.nodeseek.com')) continue;
      if (/\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(url.pathname)) continue;
      for (const key of [...url.searchParams.keys()]) {
        if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
      }
      const path = url.pathname.replace(/\/+$/, '');
      urls.add(hostname + path + url.search);
    } catch {
      // A malformed link is not a duplicate signal.
    }
  }
  return urls;
}

function addCjkTokens(text: string, tokens: Set<string>): void {
  const characters = [...text];
  let index = 0;
  while (index < characters.length) {
    if (!isCjk(characters[index]!)) { index++; continue; }
    let end = index;
    while (end < characters.length && isCjk(characters[end]!)) end++;
    if (end - index === 1) tokens.add(characters[index]!);
    else for (let pair = index; pair + 1 < end; pair++) tokens.add(characters[pair]! + characters[pair + 1]!);
    index = end;
  }
}

function addLatinTokens(text: string, tokens: Set<string>): Set<string> {
  const latin = new Set<string>();
  for (const match of text.matchAll(/[a-z0-9][a-z0-9._+-]*/g)) {
    const token = match[0].replace(/[._+-]+$/, '');
    if (token.length < 2 || SECONDARY_TOKENS.has(token)) continue;
    tokens.add(token);
    latin.add(token);
  }
  return latin;
}

function buildFeature(item: FeedItem): Feature {
  const title = normalizeText(item.title);
  const body = normalizeText(item.body || item.brief || '').slice(0, BODY_CHARS);
  const titleTokens = new Set<string>();
  const bodyTokens = new Set<string>();
  const latinTokens = addLatinTokens(title, titleTokens);
  addCjkTokens(title, titleTokens);
  addLatinTokens(body, bodyTokens);
  addCjkTokens(body, bodyTokens);
  return { title, body, titleTokens, bodyTokens, latinTokens, urls: externalUrls(item.body || item.brief) };
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return (2 * shared) / (a.size + b.size);
}

function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared++;
  return shared / small.size;
}

export function lexicalScore(a: Feature, b: Feature): number {  if (a.title && a.title === b.title) return 1;
  if (a.urls.size && b.urls.size && [...a.urls].some((url) => b.urls.has(url))) return 1;

  const titleDice = dice(a.titleTokens, b.titleTokens);
  const bodyDice = a.body.length >= MIN_BODY_CHARS && b.body.length >= MIN_BODY_CHARS
    ? dice(a.bodyTokens, b.bodyTokens)
    : 0;
  let score = bodyDice > 0 ? 0.7 * titleDice + 0.3 * bodyDice : titleDice;

  const sharedLatin = containment(a.latinTokens, b.latinTokens);
  if (sharedLatin >= 0.6) score = Math.max(score, 0.75 + 0.25 * sharedLatin);
  if (a.title.length < SHORT_TITLE_CHARS && b.title.length < SHORT_TITLE_CHARS) {
    const shared = [...a.latinTokens].some((token) => b.latinTokens.has(token));
    if (!shared) score *= 0.6;
  }
  return Math.min(1, score);
}

export function lexicalSimilarity(a: FeedItem, b: FeedItem): number {
  return lexicalScore(buildFeature(a), buildFeature(b));
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index]! * b[index]!;
    left += a[index]! ** 2;
    right += b[index]! ** 2;
  }
  if (!left || !right) return 0;
  return dot / Math.sqrt(left * right);
}

/** Keep the title whole and spend the remaining budget on the body. */
export function embeddingText(item: FeedItem, maxChars: number): string {
  const title = item.title.trim();
  const body = stripHtml(item.body || item.brief || '').replace(/\s+/g, ' ').trim();
  const budget = maxChars - title.length - 1;
  if (budget <= 0) return title.slice(0, maxChars);
  return `${title}${body ? '\n' + body.slice(0, budget) : ''}`.slice(0, maxChars);
}

export function canonicalOrder(a: StoredItem, b: StoredItem): number {
  return a.item.publishedAt - b.item.publishedAt ||
    a.item.firstSeenAt - b.item.firstSeenAt ||
    a.item.id.localeCompare(b.item.id);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Compare NodeSeek posts against older posts in the window. A lexical pass
 * picks at most a handful of candidates; embeddings confirm only those. Any
 * failure leaves the affected records unmarked so the next run retries.
 */
export async function runNodeSeekDedupe(config: IngestConfig, state: GeneratorState, now: number): Promise<DedupeRunResult> {
  const settings = config.dedupe;

  // Reset is an explicit one-shot maintenance action, so it works even after
  // the master switch was turned off for a rollback.
  if (settings.reset) {
    let cleared = 0;
    for (const record of state.records.values()) {
      if (!record.duplicateOf && !record.dedupe) continue;
      delete record.duplicateOf;
      delete record.dedupe;
      cleared++;
    }
    console.log(`[dedupe] reset: cleared markers from ${cleared} records`);
    return { checked: 0, duplicates: 0, skipped: 0, dryRun: settings.dryRun, reset: true };
  }
  if (!settings.enabled) return { checked: 0, duplicates: 0, skipped: 0, dryRun: settings.dryRun, reset: false };

  const fingerprint = dedupeFingerprint(settings);
  const cutoff = now - settings.windowDays * DAY_MS;
  const eligible = (record: StoredItem): boolean =>
    record.item.source === 'nodeseek' &&
    record.item.publishedAt >= cutoff &&
    !record.ruleHidden &&
    record.moderation !== 'hide';
  const pool = [...state.records.values()].filter(eligible);
  const queue = pool
    .filter((record) => !record.dedupe ||
      record.dedupe.hash !== record.item.contentHash ||
      record.dedupe.config !== fingerprint)
    .sort((a, b) => b.item.publishedAt - a.item.publishedAt || a.item.id.localeCompare(b.item.id))
    .slice(0, settings.maxChecks);
  if (!queue.length) return { checked: 0, duplicates: 0, skipped: 0, dryRun: settings.dryRun, reset: false };

  const features = new Map<string, Feature>();
  const featureFor = (record: StoredItem): Feature => {
    let feature = features.get(record.item.id);
    if (!feature) {
      feature = buildFeature(record.item);
      features.set(record.item.id, feature);
    }
    return feature;
  };

  const plan: Array<{ record: StoredItem; candidates: Candidate[] }> = [];
  const texts = new Map<string, string>();
  let overflow = 0;
  for (const record of queue) {
    const current = featureFor(record);
    const candidates = pool
      .filter((candidate) => candidate.item.id !== record.item.id && canonicalOrder(candidate, record) < 0)
      .map((candidate) => ({ record: candidate, score: lexicalScore(current, featureFor(candidate)) }))
      .filter((candidate) => candidate.score >= settings.lexicalThreshold)
      .sort((a, b) => b.score - a.score || canonicalOrder(a.record, b.record))
      .slice(0, settings.maxCandidates);
    if (!candidates.length) {
      plan.push({ record, candidates });
      continue;
    }
    const additions = [record, ...candidates.map((candidate) => candidate.record)]
      .filter((entry) => !texts.has(entry.item.id));
    if (texts.size + additions.length > settings.maxTexts) { overflow++; continue; }
    for (const entry of additions) texts.set(entry.item.id, embeddingText(entry.item, settings.textChars));
    plan.push({ record, candidates });
  }
  if (!plan.length) return { checked: 0, duplicates: 0, skipped: overflow, dryRun: settings.dryRun, reset: false };

  let vectors: Map<string, number[]> | null = null;
  let model = '';
  if (texts.size) {
    try {
      const ids = [...texts.keys()];
      const embedded = await createEmbedder(config, settings.timeoutMs)(ids.map((id) => texts.get(id)!));
      model = embedded.model;
      vectors = new Map(ids.map((id, index) => [id, embedded.vectors[index]!]));
    } catch (error) {
      console.warn('[dedupe] embeddings unavailable; retrying unmarked records later:', String(error));
    }
  }

  let checked = 0;
  let duplicates = 0;
  let skipped = overflow;
  for (const { record, candidates } of plan) {
    if (candidates.length) {
      if (!vectors) { skipped++; continue; }
      const currentVector = vectors.get(record.item.id);
      if (!currentVector) { skipped++; continue; }
      // Earliest confirmed post wins, so the root stays stable across runs.
      let canonical: Candidate | undefined;
      let similarity = 0;
      for (const candidate of [...candidates].sort((a, b) => canonicalOrder(a.record, b.record))) {
        const candidateVector = vectors.get(candidate.record.item.id);
        if (!candidateVector) continue;
        const value = cosine(currentVector, candidateVector);
        if (value >= settings.cosineThreshold) { canonical = candidate; similarity = value; break; }
      }
      if (canonical) {
        checked++;
        duplicates++;
        if (settings.dryRun) {
          console.log(`[dedupe] would hide ${record.item.id} as ${canonical.record.item.id} lexical=${round(candidates[0]!.score)} cosine=${round(similarity)} titles=${JSON.stringify([record.item.title, canonical.record.item.title])}`);
          continue;
        }
        const marker: DedupeMarker = {
          hash: record.item.contentHash,
          config: fingerprint,
          checkedAt: now,
          candidateId: candidates[0]!.record.item.id,
          lexical: round(candidates[0]!.score),
          cosine: round(similarity),
          canonicalHash: canonical.record.item.contentHash,
          ...(model ? { model } : {}),
        };
        record.duplicateOf = canonical.record.item.id;
        record.dedupe = marker;
        continue;
      }
    }

    if (settings.dryRun) { checked++; continue; }
    delete record.duplicateOf;
    record.dedupe = {
      hash: record.item.contentHash,
      config: fingerprint,
      checkedAt: now,
      ...(candidates.length ? { candidateId: candidates[0]!.record.item.id, lexical: round(candidates[0]!.score) } : {}),
      ...(vectors && model ? { model } : {}),
    };
    checked++;
  }
  return { checked, duplicates, skipped, dryRun: settings.dryRun, reset: false };
}
