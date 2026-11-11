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
};

export const SOURCE_ORDER: SourceId[] = [...SOURCE_IDS];

export function isSourceId(value: unknown): value is SourceId {
  return typeof value === 'string' && (SOURCE_IDS as readonly string[]).includes(value);
}
