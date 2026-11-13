import type { SourceId } from './types';
import { SOURCE_IDS } from './types';

export interface SourceMeta {
  id: SourceId;
  name: string;
  shortName: string;
  home: string;
  color: string;
}

export const SOURCES: Record<SourceId, SourceMeta> = {
  x: {
    id: 'x',
    name: 'X',
    shortName: 'X',
    home: 'https://x.com',
    color: '#111111',
  },
  v2ex: {
    id: 'v2ex',
    name: 'V2EX',
    shortName: 'V2EX',
    home: 'https://www.v2ex.com',
    color: '#4b5563',
  },
  nodeseek: {
    id: 'nodeseek',
    name: 'NodeSeek',
    shortName: 'NodeSeek',
    home: 'https://www.nodeseek.com',
    color: '#111827',
  },
  linuxdo: {
    id: 'linuxdo',
    name: 'LINUX DO',
    shortName: 'LINUX DO',
    home: 'https://linux.do',
    color: '#111827',
  },
  hn: {
    id: 'hn',
    name: 'Hacker News',
    shortName: 'Hacker News',
    home: 'https://news.ycombinator.com',
    color: '#f26522',
  },
  github: {
    id: 'github',
    name: 'GitHub Trending',
    shortName: 'GitHub',
    home: 'https://github.com/trending',
    color: '#24292f',
  },
  reddit: {
    id: 'reddit',
    name: 'Reddit',
    shortName: 'Reddit',
    home: 'https://www.reddit.com',
    color: '#ff4500',
  },
  'hf-papers': {
    id: 'hf-papers',
    name: 'Hugging Face Daily Papers',
    shortName: 'HF Papers',
    home: 'https://huggingface.co/papers',
    color: '#ffd21e',
  },
  simonw: {
    id: 'simonw',
    name: 'Simon Willison',
    shortName: 'Simon Willison',
    home: 'https://simonwillison.net',
    color: '#0f766e',
  },
  'google-ai': {
    id: 'google-ai',
    name: 'Google AI',
    shortName: 'Google AI',
    home: 'https://blog.google/innovation-and-ai/technology/ai/',
    color: '#4285f4',
  },
  producthunt: {
    id: 'producthunt',
    name: 'Product Hunt',
    shortName: 'Product Hunt',
    home: 'https://www.producthunt.com',
    color: '#da552f',
  },
};

export const SOURCE_ORDER: SourceId[] = [...SOURCE_IDS];

/**
 * Descriptive English titles are translated automatically. Product Hunt
 * titles are product names, so they stay in their original form.
 */
export const TITLE_TRANSLATION_SOURCES: ReadonlySet<SourceId> = new Set([
  'x',
  'hn',
  'reddit',
  'hf-papers',
  'simonw',
  'google-ai',
]);

export const BRIEF_TRANSLATION_SOURCES: ReadonlySet<SourceId> = new Set([
  'github',
  'hf-papers',
  'simonw',
  'google-ai',
  'producthunt',
]);

export const LATEST_ONLY_SOURCES: ReadonlySet<SourceId> = new Set([
  'simonw',
  'google-ai',
  'producthunt',
]);

export function isSourceId(value: unknown): value is SourceId {
  return typeof value === 'string' && (SOURCE_IDS as readonly string[]).includes(value);
}

export function sourceNeedsTitleTranslation(source: SourceId): boolean {
  return TITLE_TRANSLATION_SOURCES.has(source);
}

export function sourceNeedsBriefTranslation(source: SourceId): boolean {
  return BRIEF_TRANSLATION_SOURCES.has(source);
}
