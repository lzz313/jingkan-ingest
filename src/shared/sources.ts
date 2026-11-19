import type { SourceId } from './types';
import { SOURCE_IDS } from './types';

export interface SourceMeta {
  id: SourceId;
  name: string;
  shortName: string;
  home: string;
  color: string;
  /**
   * One sentence describing what this source page shows and how to read it.
   * Used as the page meta description and as the visible page intro, so it
   * must stay accurate and unique per source.
   */
  description: string;
}

export const SOURCES: Record<SourceId, SourceMeta> = {
  x: {
    id: 'x',
    name: 'X',
    shortName: 'X',
    home: 'https://x.com',
    color: '#111111',
    description: '追踪 X 上 AI、产品与科技圈的高热讨论，提供中文标题与译文，并保留作者、互动数据与原推直达。',
  },
  v2ex: {
    id: 'v2ex',
    name: 'V2EX',
    shortName: 'V2EX',
    home: 'https://www.v2ex.com',
    color: '#4b5563',
    description: '汇总 V2EX 最新与热门技术、生活讨论，已过滤推广节点与低质广告，保留作者、回复数与原文链接。',
  },
  nodeseek: {
    id: 'nodeseek',
    name: 'NodeSeek',
    shortName: 'NodeSeek',
    home: 'https://www.nodeseek.com',
    color: '#111827',
    description: '汇总 NodeSeek 的服务器、网络与建站讨论，已过滤重复水帖与低质广告，保留 RSS 摘要与原帖直达。',
  },
  linuxdo: {
    id: 'linuxdo',
    name: 'LINUX DO',
    shortName: 'LINUX DO',
    home: 'https://linux.do',
    color: '#111827',
    description: '汇总 LINUX DO 的 AI、开发与资源分享讨论，已过滤推广与低质内容，保留互动热度与原帖直达。',
  },
  hn: {
    id: 'hn',
    name: 'Hacker News',
    shortName: 'Hacker News',
    home: 'https://news.ycombinator.com',
    color: '#f26522',
    description: '追踪 Hacker News 的技术与创业热门话题，提供中文标题与正文译文，保留分数、评论数与原文及讨论链接。',
  },
  github: {
    id: 'github',
    name: 'GitHub Trending',
    shortName: 'GitHub',
    home: 'https://github.com/trending',
    color: '#24292f',
    description: '精选 GitHub Trending 当日热门开源项目，附带中文简介、编程语言、Star 增长与仓库直达链接。',
  },
  reddit: {
    id: 'reddit',
    name: 'Reddit',
    shortName: 'Reddit',
    home: 'https://www.reddit.com',
    color: '#ff4500',
    description: '追踪 Reddit 科技与 AI 社区的高热讨论，提供中文标题与原文链接，并保留赞数、评论数等互动数据。',
  },
  'hf-papers': {
    id: 'hf-papers',
    name: 'Hugging Face Daily Papers',
    shortName: 'HF Papers',
    home: 'https://huggingface.co/papers',
    color: '#ffd21e',
    description: '精选 Hugging Face Daily Papers 每日 AI 论文，提供中文标题与核心摘要，保留作者与论文原文直达。',
  },
  simonw: {
    id: 'simonw',
    name: 'Simon Willison',
    shortName: 'Simon Willison',
    home: 'https://simonwillison.net',
    color: '#0f766e',
    description: '同步 Simon Willison 关于 AI 工具与工程实践的一手文章，提供中文标题、摘要与原文直达。',
  },
  'google-ai': {
    id: 'google-ai',
    name: 'Google AI',
    shortName: 'Google AI',
    home: 'https://blog.google/innovation-and-ai/technology/ai/',
    color: '#4285f4',
    description: '同步 Google AI 官方博客的模型、研究与产品发布，提供中文标题、核心摘要与官方原文直达。',
  },
  producthunt: {
    id: 'producthunt',
    name: 'Product Hunt',
    shortName: 'Product Hunt',
    home: 'https://www.producthunt.com',
    color: '#da552f',
    description: '精选 Product Hunt 每日上线科技新品，保留产品原名与官网链接，并附中文简介快速了解用途。',
  },
};

export const SOURCE_ORDER: SourceId[] = [...SOURCE_IDS];

/**
 * Sources whose descriptive English titles are translated automatically.
 * Product Hunt titles are product names, so they stay in their original form.
 */
export const TITLE_TRANSLATION_SOURCES: ReadonlySet<SourceId> = new Set([
  'x',
  'hn',
  'reddit',
  'hf-papers',
  'simonw',
  'google-ai',
]);

/** Sources with a translated short summary stored in `brief_zh`. */
export const BRIEF_TRANSLATION_SOURCES: ReadonlySet<SourceId> = new Set([
  'github',
  'hf-papers',
  'simonw',
  'google-ai',
  'producthunt',
]);

/** Sources whose card summary is replaced by its Chinese translation. */
export const CHINESE_SUMMARY_SOURCES: ReadonlySet<SourceId> = new Set([
  'hf-papers',
  'simonw',
  'google-ai',
  'producthunt',
]);

/** Curated publication feeds without a meaningful engagement signal. */
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

export function sourceUsesChineseSummary(source: SourceId): boolean {
  return CHINESE_SUMMARY_SOURCES.has(source);
}
