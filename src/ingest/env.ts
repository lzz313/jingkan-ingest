export interface IngestConfig {
  baseUrl: string;
  ingestToken: string;
  prewarmTranslations: boolean;
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
  };
}
