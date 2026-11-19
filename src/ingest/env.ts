import { parseXTrustedHandles } from '../shared/x-quality';

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

export interface ClusterConfig {
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

/**
 * Cross-source clustering is opt-in: a wrong merge is more visible than a
 * missed one, so the first runs should be dry runs against real traffic.
 */
export const CLUSTER_DEFAULTS: ClusterConfig = {
  enabled: false,
  dryRun: false,
  reset: false,
  windowDays: 3,
  maxChecks: 40,
  maxCandidates: 5,
  lexicalThreshold: 0.18,
  cosineThreshold: 0.86,
  textChars: 500,
  maxTexts: 160,
  timeoutMs: 20_000,
};

export interface IngestConfig {
  baseUrl: string;
  ingestToken: string;
  prewarmTranslations: boolean;
  dedupe: DedupeConfig;
  cluster: ClusterConfig;
  /** Replaces the curated X hot-view allowlist when configured. */
  xTrustedHandles?: ReadonlySet<string>;
  /** Set X_HOT_GATE=0 to roll the hot-view quality gate back. */
  xHotGate?: boolean;
  /** Optional public IndexNow key matching `/<key>.txt` on the Worker. */
  indexNowKey?: string;
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

/** Read the cross-source clustering switches; everything unset stays off/safe. */
export function loadClusterConfig(env: NodeJS.ProcessEnv = process.env): ClusterConfig {
  return {
    enabled: flag(env.CROSS_SOURCE_CLUSTER),
    dryRun: flag(env.CROSS_SOURCE_CLUSTER_DRY_RUN),
    reset: flag(env.CROSS_SOURCE_CLUSTER_RESET),
    windowDays: bounded(env.CROSS_SOURCE_CLUSTER_WINDOW_DAYS, CLUSTER_DEFAULTS.windowDays, 1, 14, true),
    maxChecks: bounded(env.CROSS_SOURCE_CLUSTER_MAX_CHECKS, CLUSTER_DEFAULTS.maxChecks, 1, 200, true),
    maxCandidates: bounded(env.CROSS_SOURCE_CLUSTER_MAX_CANDIDATES, CLUSTER_DEFAULTS.maxCandidates, 1, 10, true),
    lexicalThreshold: bounded(env.CROSS_SOURCE_CLUSTER_LEXICAL, CLUSTER_DEFAULTS.lexicalThreshold, 0, 1),
    cosineThreshold: bounded(env.CROSS_SOURCE_CLUSTER_COSINE, CLUSTER_DEFAULTS.cosineThreshold, 0.5, 0.99),
    textChars: bounded(env.CROSS_SOURCE_CLUSTER_TEXT_CHARS, CLUSTER_DEFAULTS.textChars, 100, 1200, true),
    maxTexts: bounded(env.CROSS_SOURCE_CLUSTER_MAX_TEXTS, CLUSTER_DEFAULTS.maxTexts, 20, 400, true),
    timeoutMs: bounded(env.CROSS_SOURCE_CLUSTER_TIMEOUT_MS, CLUSTER_DEFAULTS.timeoutMs, 5_000, 60_000, true),
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
    cluster: loadClusterConfig(),
    xTrustedHandles: parseXTrustedHandles(process.env.X_TRUSTED_HANDLES),
    xHotGate: process.env.X_HOT_GATE !== '0',
    indexNowKey: process.env.INDEXNOW_KEY?.trim() || undefined,
  };
}
