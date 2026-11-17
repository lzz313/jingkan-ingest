import { hashText, stripHtml } from '../shared/html';
import { isUsableTranslation } from '../shared/translation';
import type { FeedItem } from '../shared/types';
import type { ClusterConfig, IngestConfig } from './env';
import { createEmbedder } from './embed-client';
import { canonicalOrder, cosine, embeddingText } from './dedupe';
import type { ClusterMarker, GeneratorState, StoredItem } from './state';

const ALGORITHM_VERSION = 'cross-source-cluster-v2';
const DAY_MS = 86400000;
const TRACKING_PARAM = /^(?:utm_.+|ref|aff|spm|from|share|share_token)$/i;
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const LINK_FIELDS = ['articleUrl', 'arxivUrl', 'paperUrl', 'productUrl', 'hnUrl'] as const;
const MIN_BODY_TOKENS = 8;
const MIN_LATIN_CHARS = 3;
/**
 * Generic words that appear across unrelated titles. A two-character token
 * like "AI" is already excluded by MIN_LATIN_CHARS; the rest would otherwise
 * make the title-containment shortcut fire on noise.
 */
const SECONDARY_TOKENS = new Set([
  'www', 'com', 'cn', 'net', 'org', 'http', 'https', 'html', 'htm', 'php',
  'api', 'app', 'cdn', 'img', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
  'vps', 'llm', 'llms', 'the', 'and', 'for', 'with', 'from', 'this', 'that',
  'new', 'show', 'ask', 'how', 'why', 'what', 'use', 'about', 'into',
]);

export interface ClusterRunResult {
  checked: number;
  clusters: number;
  skipped: number;
  dryRun: boolean;
  reset: boolean;
}

interface Feature {
  /** A FeedItem whose title/body carry both languages, for the embedder. */
  item: FeedItem;
  titleTokens: Set<string>;
  bodyTokens: Set<string>;
  latinTokens: Set<string>;
  links: Set<string>;
}

interface Candidate {
  record: StoredItem;
  lexical: number;
  sharedUrl: string | null;
}

/** Settings that can change a verdict; count/timeout knobs deliberately excluded. */
export function clusterFingerprint(config: ClusterConfig): string {
  return hashText(JSON.stringify([
    ALGORITHM_VERSION,
    config.windowDays,
    config.lexicalThreshold,
    config.cosineThreshold,
    config.textChars,
  ]));
}

/** Host + path + non-tracking query, or null for a homepage/image/bad URL. */
function linkKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (IMAGE_PATH.test(url.pathname)) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    const path = url.pathname.replace(/\/+$/, '');
    // A bare homepage is a source link, not evidence of the same story.
    if (!path && !url.search) return null;
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return hostname + path + url.search;
  } catch {
    return null;
  }
}

function itemLinks(item: FeedItem): Set<string> {
  const raw: string[] = [item.url];
  for (const field of LINK_FIELDS) {
    const value = item.extra[field];
    if (typeof value === 'string') raw.push(value);
  }
  if (Array.isArray(item.extra.relatedUrls)) {
    raw.push(...item.extra.relatedUrls.filter((value): value is string => typeof value === 'string'));
  }
  for (const text of [item.body, item.brief, item.bodyZh, item.briefZh]) {
    if (!text) continue;
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>()]+/gi)) {
      raw.push(match[0].replace(/[),.;!?，。；！？]+$/, ''));
    }
  }
  const links = new Set<string>();
  for (const value of raw) {
    const key = linkKey(value);
    if (key) links.add(key);
  }
  return links;
}

function isCjk(character: string): boolean {
  return /[㐀-鿿豈-﫿]/.test(character);
}

function normalizeText(value: string | null | undefined): string {
  return stripHtml(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/[^\s"'<>()]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** CJK has no spaces, so adjacent-character pairs stand in for words. */
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
    if (token.length < MIN_LATIN_CHARS || SECONDARY_TOKENS.has(token)) continue;
    tokens.add(token);
    latin.add(token);
  }
  return latin;
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

/**
 * Fold translated fields into the text the lexical and embedding passes see.
 * URLs stay out of the text; they are compared as exact links instead.
 */
function buildFeature(item: FeedItem): Feature {
  const titleZh = isUsableTranslation(item.title, item.titleZh) ? item.titleZh : null;
  const briefOriginal = item.brief || item.body || item.title;
  const briefZh = isUsableTranslation(briefOriginal, item.briefZh) ? item.briefZh : null;
  const bodyZh = isUsableTranslation(item.body, item.bodyZh) ? item.bodyZh : null;
  const title = [item.title, titleZh].filter(Boolean).join(' ');
  const body = [bodyZh, briefZh, item.brief, item.body].filter(Boolean).join('\n');
  const normalizedTitle = normalizeText(title);
  const normalizedBody = normalizeText(body);
  const titleTokens = new Set<string>();
  const latinTokens = addLatinTokens(normalizedTitle, titleTokens);
  addCjkTokens(normalizedTitle, titleTokens);
  const bodyTokens = new Set<string>();
  addLatinTokens(normalizedBody, bodyTokens);
  addCjkTokens(normalizedBody, bodyTokens);
  return {
    item: { ...item, title, body },
    titleTokens,
    bodyTokens,
    latinTokens,
    links: itemLinks(item),
  };
}

/**
 * Cross-source prefilter. It deliberately omits NodeSeek's "any shared Latin
 * title token is a match" shortcut: across sources, a bare "AI" or "API" in
 * otherwise unrelated titles would otherwise flood the embedding queue.
 */
function lexicalScore(a: Feature, b: Feature): number {
  const titleDice = dice(a.titleTokens, b.titleTokens);
  const bodyDice = a.bodyTokens.size >= MIN_BODY_TOKENS && b.bodyTokens.size >= MIN_BODY_TOKENS
    ? dice(a.bodyTokens, b.bodyTokens)
    : 0;
  let score = bodyDice > 0 ? 0.75 * titleDice + 0.25 * bodyDice : titleDice;
  // A distinctive product token ("cloudflare", "bge-m3") still bridges a
  // translated title, where CJK bigrams cannot overlap.
  const sharedLatin = containment(a.latinTokens, b.latinTokens);
  if (sharedLatin >= 0.6) score = Math.max(score, 0.6 + 0.4 * sharedLatin);
  return Math.min(1, score);
}

function sharedLink(a: Feature, b: Feature): string | null {
  if (!a.links.size || !b.links.size) return null;
  const [small, large] = a.links.size <= b.links.size ? [a.links, b.links] : [b.links, a.links];
  for (const link of small) if (large.has(link)) return link;
  return null;
}

/** Follow cluster pointers to the earliest still-visible root. */
function clusterRoot(state: GeneratorState, record: StoredItem): StoredItem | null {
  let current = record;
  const seen = new Set<string>();
  while (current.clusterOf) {
    if (seen.has(current.item.id)) return null;
    seen.add(current.item.id);
    const parent = state.records.get(current.clusterOf);
    if (!parent) return null;
    current = parent;
  }
  if (current.ruleHidden || current.moderation !== 'keep' || current.duplicateOf) return null;
  return current;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Merge the same story across sources into one card.
 *
 * Only newer records are checked, against older records from a different
 * source, and the oldest match becomes the root. A shared article URL skips
 * the embedding call; everything else needs a lexical prefilter plus a cosine
 * verdict. Every failure leaves the record unmarked so the next run retries.
 */
export async function runCrossSourceClusters(
  config: IngestConfig,
  state: GeneratorState,
  now: number,
): Promise<ClusterRunResult> {
  const settings = config.cluster;

  // Reset stays available after the master switch is turned off for a rollback.
  if (settings.reset) {
    let cleared = 0;
    for (const record of state.records.values()) {
      if (!record.clusterOf && !record.cluster) continue;
      delete record.clusterOf;
      delete record.cluster;
      cleared++;
    }
    console.log(`[cluster] reset: cleared markers from ${cleared} records`);
    return { checked: 0, clusters: 0, skipped: 0, dryRun: settings.dryRun, reset: true };
  }
  if (!settings.enabled) return { checked: 0, clusters: 0, skipped: 0, dryRun: settings.dryRun, reset: false };

  const fingerprint = clusterFingerprint(settings);
  const cutoff = now - settings.windowDays * DAY_MS;
  const pool = [...state.records.values()].filter((record) =>
    record.item.publishedAt >= cutoff &&
    !record.ruleHidden &&
    record.moderation === 'keep' &&
    !record.duplicateOf);
  const queue = pool
    .filter((record) => !record.cluster ||
      record.cluster.hash !== record.item.contentHash ||
      record.cluster.config !== fingerprint)
    .sort((a, b) => b.item.publishedAt - a.item.publishedAt || a.item.id.localeCompare(b.item.id))
    .slice(0, settings.maxChecks);
  if (!queue.length) return { checked: 0, clusters: 0, skipped: 0, dryRun: settings.dryRun, reset: false };

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
      .filter((candidate) =>
        candidate.item.id !== record.item.id &&
        candidate.item.source !== record.item.source &&
        canonicalOrder(candidate, record) < 0)
      .map((candidate): Candidate => {
        const other = featureFor(candidate);
        const url = sharedLink(current, other);
        return {
          record: candidate,
          lexical: url ? 1 : lexicalScore(current, other),
          sharedUrl: url,
        };
      })
      .filter((candidate) => candidate.sharedUrl || candidate.lexical >= settings.lexicalThreshold)
      // A confirmed article link is stronger evidence than a lexical guess.
      .sort((a, b) =>
        Number(Boolean(b.sharedUrl)) - Number(Boolean(a.sharedUrl)) ||
        b.lexical - a.lexical ||
        canonicalOrder(a.record, b.record))
      .slice(0, settings.maxCandidates)
      .filter((candidate) => {
        const root = clusterRoot(state, candidate.record);
        return Boolean(root) &&
          root!.item.id !== record.item.id &&
          root!.item.source !== record.item.source;
      });
    if (!candidates.length) {
      plan.push({ record, candidates });
      continue;
    }
    const needsEmbedding = candidates.some((candidate) => !candidate.sharedUrl);
    if (!needsEmbedding) {
      plan.push({ record, candidates });
      continue;
    }
    const additions = [record, ...candidates.map((candidate) => candidate.record)]
      .filter((entry) => !texts.has(entry.item.id));
    if (texts.size + additions.length > settings.maxTexts) { overflow++; continue; }
    for (const entry of additions) texts.set(entry.item.id, embeddingText(featureFor(entry).item, settings.textChars));
    plan.push({ record, candidates });
  }
  if (!plan.length) return { checked: 0, clusters: 0, skipped: overflow, dryRun: settings.dryRun, reset: false };

  let vectors: Map<string, number[]> | null = null;
  let model = '';
  if (texts.size) {
    try {
      const ids = [...texts.keys()];
      const embedded = await createEmbedder(config, settings.timeoutMs)(ids.map((id) => texts.get(id)!));
      model = embedded.model;
      vectors = new Map(ids.map((id, index) => [id, embedded.vectors[index]!]));
    } catch (error) {
      console.warn('[cluster] embeddings unavailable; retrying unmarked records later:', String(error));
    }
  }

  let checked = 0;
  let clusters = 0;
  let skipped = overflow;
  for (const { record, candidates } of plan) {
    let root: StoredItem | null = null;
    let matched: Candidate | null = null;
    let similarity = 0;

    // Shared article URLs are self-confirming and need no model call.
    for (const candidate of candidates) {
      if (!candidate.sharedUrl) continue;
      const candidateRoot = clusterRoot(state, candidate.record);
      if (!candidateRoot || candidateRoot.item.id === record.item.id ||
        candidateRoot.item.source === record.item.source) continue;
      root = candidateRoot;
      matched = candidate;
      similarity = 1;
      break;
    }
    if (!root && candidates.some((candidate) => !candidate.sharedUrl)) {
      if (!vectors) { skipped++; continue; }
      const currentVector = vectors.get(record.item.id);
      if (!currentVector) { skipped++; continue; }
      const embeddable = candidates
        .filter((candidate) => !candidate.sharedUrl)
        .sort((a, b) => canonicalOrder(a.record, b.record));
      for (const candidate of embeddable) {
        const candidateVector = vectors.get(candidate.record.item.id);
        if (!candidateVector) continue;
        const value = cosine(currentVector, candidateVector);
        if (value < settings.cosineThreshold) continue;
        const candidateRoot = clusterRoot(state, candidate.record);
        if (!candidateRoot || candidateRoot.item.id === record.item.id ||
          candidateRoot.item.source === record.item.source) continue;
        root = candidateRoot;
        matched = candidate;
        similarity = value;
        break;
      }
    }

    if (root && matched) {
      checked++;
      clusters++;
      if (settings.dryRun) {
        console.log(`[cluster] would merge ${record.item.id} into ${root.item.id} lexical=${round(matched.lexical)} cosine=${round(similarity)} shared=${matched.sharedUrl ?? '-'} titles=${JSON.stringify([record.item.title, root.item.title])}`);
        continue;
      }
      // If this record was a root, its children now belong to the new root.
      // A child from the new root's own source would turn into a same-source
      // related link, so release it to stand on its own instead.
      for (const child of state.records.values()) {
        if (child.clusterOf !== record.item.id) continue;
        if (child.item.source === root.item.source) {
          delete child.clusterOf;
          delete child.cluster;
          continue;
        }
        child.clusterOf = root.item.id;
        if (child.cluster) child.cluster.canonicalHash = root.item.contentHash;
      }
      const marker: ClusterMarker = {
        hash: record.item.contentHash,
        config: fingerprint,
        checkedAt: now,
        candidateId: matched.record.item.id,
        lexical: round(matched.lexical),
        canonicalHash: root.item.contentHash,
        ...(matched.sharedUrl
          ? { sharedUrl: matched.sharedUrl }
          : { cosine: round(similarity), ...(model ? { model } : {}) }),
      };
      record.clusterOf = root.item.id;
      record.cluster = marker;
      continue;
    }

    if (settings.dryRun) { checked++; continue; }
    delete record.clusterOf;
    record.cluster = {
      hash: record.item.contentHash,
      config: fingerprint,
      checkedAt: now,
      ...(candidates.length ? {
        candidateId: candidates[0]!.record.item.id,
        lexical: round(candidates[0]!.lexical),
        ...(candidates[0]!.sharedUrl ? { sharedUrl: candidates[0]!.sharedUrl } : {}),
      } : {}),
      ...(vectors && model ? { model } : {}),
    };
    checked++;
  }
  return { checked, clusters, skipped, dryRun: settings.dryRun, reset: false };
}
