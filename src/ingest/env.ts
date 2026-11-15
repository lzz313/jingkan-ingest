export interface DedupeConfig {
  enabled: boolean;
  dryRun: boolean;
  reset: boolean;
  windowDays: number;
  maxChecks: number;
  maxCandidates: number;
  lexicalThreshold: number;
  cosineThreshold: number;
  textChars: number;
  maxTexts: number;
  timeoutMs: number;
}

export const DEDUPE_DEFAULTS: DedupeConfig = {
  enabled: false,
  dryRun: false,
  reset: false,
  windowDays: 7,
  maxChecks: 20,
  maxCandidates: 5,
  lexicalThreshold: 0.18,
  cosineThreshold: 0.82,
  textChars: 500,
  maxTexts: 120,
  timeoutMs: 20_000,
};

export interface IngestConfig {
  baseUrl: string;
  ingestToken: string;
  prewarmTranslations: boolean;
  dedupe: DedupeConfig;
}

function flag(value: string | undefined): boolean {
  return value === '1';
}

function bounded(value: string | undefined, fallback: number, min: number, max: number, whole = false): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || value === '') return fallback;
  const clamped = Math.min(max, Math.max(min, parsed));
  return whole ? Math.floor(clamped) : clamped;
}

/** Read the NodeSeek dedupe switches; an unset or malformed value keeps the safe default. */
export function loadDedupeConfig(env: NodeJS.ProcessEnv = process.env): DedupeConfig {
  return {
    enabled: flag(env.NODESEEK_DEDUPE),
    dryRun: flag(env.NODESEEK_DEDUPE_DRY_RUN),
    reset: flag(env.NODESEEK_DEDUPE_RESET),
    windowDays: bounded(env.NODESEEK_DEDUPE_WINDOW_DAYS, DEDUPE_DEFAULTS.windowDays, 1, 30, true),
    maxChecks: bounded(env.NODESEEK_DEDUPE_MAX_CHECKS, DEDUPE_DEFAULTS.maxChecks, 1, 200, true),
    maxCandidates: bounded(env.NODESEEK_DEDUPE_MAX_CANDIDATES, DEDUPE_DEFAULTS.maxCandidates, 1, 10, true),
    lexicalThreshold: bounded(env.NODESEEK_DEDUPE_LEXICAL, DEDUPE_DEFAULTS.lexicalThreshold, 0, 1),
    cosineThreshold: bounded(env.NODESEEK_DEDUPE_COSINE, DEDUPE_DEFAULTS.cosineThreshold, 0.5, 0.99),
    textChars: bounded(env.NODESEEK_DEDUPE_TEXT_CHARS, DEDUPE_DEFAULTS.textChars, 100, 1200, true),
    maxTexts: bounded(env.NODESEEK_DEDUPE_MAX_TEXTS, DEDUPE_DEFAULTS.maxTexts, 20, 400, true),
    timeoutMs: bounded(env.NODESEEK_DEDUPE_TIMEOUT_MS, DEDUPE_DEFAULTS.timeoutMs, 5_000, 60_000, true),
  };
}

export function loadConfig(): IngestConfig {
  const baseUrl = (process.env.JINGKAN_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(baseUrl);
  const ingestToken = process.env.INGEST_TOKEN || (isLocal ? 'dev-token-change-me' : '');

  if (!ingestToken) {
    throw new Error('INGEST_TOKEN is required when JINGKAN_BASE_URL points at a deployed Worker');
  }

  return {
    baseUrl,
    ingestToken,
    prewarmTranslations: process.env.PREWARM_TRANSLATIONS !== '0',
    dedupe: loadDedupeConfig(),
  };
}
