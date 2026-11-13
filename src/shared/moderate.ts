import type { ModerationReason, SourceId } from './types';

/**
 * Sources that go through AI moderation. Must stay in sync with the
 * rule-based community sources in `spam.ts`; the other feeds (HN, Reddit,
 * GitHub, X) are curated upstream and are never hidden by the model.
 */
export const MODERATE_SOURCES: SourceId[] = ['v2ex', 'nodeseek', 'linuxdo'];

/** Prompt inputs stay short: the verdict only needs the gist of a post. */
export const MODERATION_TITLE_MAX = 200;
export const MODERATION_BODY_MAX = 240;

export interface ModerationEntry {
  title: string;
  body: string;
}

export interface ModerationDecision {
  index: number;
  hide: boolean;
  reason: ModerationReason | null;
}

export interface ModerationParseResult {
  ok: boolean;
  /** One decision per input, in order; invalid/missing entries default to keep. */
  decisions: ModerationDecision[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Trim and flatten a post down to what the moderator actually reads. */
export function moderationEntry(
  title: string | null | undefined,
  body: string | null | undefined,
): ModerationEntry {
  return {
    title: (title ?? '').replace(/\s+/g, ' ').trim().slice(0, MODERATION_TITLE_MAX),
    body: (body ?? '').replace(/\s+/g, ' ').trim().slice(0, MODERATION_BODY_MAX),
  };
}

const REASON_MAP: Record<string, ModerationReason> = {
  spam: 'spam',
  ad: 'spam',
  ads: 'spam',
  advertisement: 'spam',
  advertising: 'spam',
  promo: 'spam',
  promotion: 'spam',
  '广告': 'spam',
  '引流': 'spam',
  '推广': 'spam',
  low_quality: 'low_quality',
  low: 'low_quality',
  lq: 'low_quality',
  '低质量': 'low_quality',
  '水帖': 'low_quality',
  '水贴': 'low_quality',
  '灌水': 'low_quality',
};

/** Accept the model's own wording ("low quality", "广告") but nothing else. */
export function normalizeModerationReason(value: unknown): ModerationReason | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (REASON_MAP[key]) return REASON_MAP[key];
  if (/low_quality|低质|水帖|水贴|灌水/.test(key)) return 'low_quality';
  if (/spam|广告|引流|推广/.test(key)) return 'spam';
  return null;
}

/** Span of the first balanced JSON object/array starting at `start`. */
function balancedSpan(text: string, start: number): string | null {
  const open = text[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Models wrap JSON in code fences or add a sentence before/after it. Try every
 * plausible opening bracket (bounded) and return the first thing that parses.
 */
function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const starts: number[] = [];
  for (let index = 0; index < stripped.length && starts.length < 8; index++) {
    if (stripped[index] === '{' || stripped[index] === '[') starts.push(index);
  }
  for (const start of starts) {
    const span = balancedSpan(stripped, start);
    if (!span) continue;
    try {
      return JSON.parse(span) as unknown;
    } catch {
      // Try the next opening bracket.
    }
  }
  return undefined;
}

/**
 * Parse a moderation batch. Returns `ok: false` when the reply is not usable
 * at all, so the caller leaves every row unchecked for the next round instead
 * of persisting a guess. Anything ambiguous inside an otherwise valid reply
 * falls back to "keep": hiding is the destructive direction.
 */
export function parseModerationResponse(text: string, batchSize: number, requireComplete = false): ModerationParseResult {
  const decisions = Array.from({ length: batchSize }, (_, index) => ({
    index,
    hide: false,
    reason: null,
  })) as ModerationDecision[];

  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : asRecord(parsed)?.results;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, decisions };

  if (requireComplete) {
    const valid = new Set<number>();
    for (const entry of list) {
      const record = asRecord(entry);
      const index = record?.i ?? record?.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= batchSize ||
          typeof record?.hide !== 'boolean' || (record.hide && !normalizeModerationReason(record.reason))) continue;
      valid.add(index);
    }
    if (valid.size !== batchSize) return { ok: false, decisions };
  }
  const seen = new Set<number>();
  for (const entry of list) {
    const record = asRecord(entry);
    if (!record) continue;
    const index = record.i ?? record.index;
    if (typeof index !== 'number' || !Number.isInteger(index)) continue;
    if (index < 0 || index >= batchSize || seen.has(index)) continue;
    if (record.hide !== true) continue;
    const reason = normalizeModerationReason(record.reason);
    if (!reason) continue;
    seen.add(index);
    decisions[index] = { index, hide: true, reason };
  }
  return { ok: true, decisions };
}
