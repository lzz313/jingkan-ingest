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
    description: '浏览 X 上关于 AI、产品与技术的热门讨论，按发布时间排列，保留作者、互动数据与原文链接，英文内容提供中文摘要。',
  },
  v2ex: {
    id: 'v2ex',
    name: 'V2EX',
    shortName: 'V2EX',
    home: 'https://www.v2ex.com',
    color: '#4b5563',
    description: '浏览 V2EX 的技术与生活讨论，按发布时间排列，保留作者、回复数与原文链接，社区推广节点已排除。',
  },
  nodeseek: {
    id: 'nodeseek',
    name: 'NodeSeek',
    shortName: 'NodeSeek',
    home: 'https://www.nodeseek.com',
    color: '#111827',
    description: '浏览 NodeSeek 的服务器、网络与建站讨论，按发布时间排列，保留作者、互动数据与原文链接，内容仅取 RSS 摘要。',
  },
  linuxdo: {
    id: 'linuxdo',
    name: 'LINUX DO',
    shortName: 'LINUX DO',
    home: 'https://linux.do',
    color: '#111827',
    description: '浏览 LINUX DO 的 AI、开发与资源分享讨论，按发布时间排列，保留作者、互动数据与原文链接，方便继续阅读。',
  },
  hn: {
    id: 'hn',
    name: 'Hacker News',
    shortName: 'Hacker News',
    home: 'https://news.ycombinator.com',
    color: '#f26522',
    description: '浏览 Hacker News 的技术与创业讨论，按发布时间排列，保留作者、分数、评论数与原文链接，英文内容提供中文摘要。',
  },
  github: {
    id: 'github',
    name: 'GitHub Trending',
    shortName: 'GitHub',
    home: 'https://github.com/trending',
    color: '#24292f',
    description: '浏览 GitHub Trending 的当日热门开源项目，保留语言、Star 数、中文摘要与仓库链接，帮助快速判断项目方向。',
  },
  reddit: {
    id: 'reddit',
    name: 'Reddit',
    shortName: 'Reddit',
    home: 'https://www.reddit.com',
    color: '#ff4500',
    description: '浏览 Reddit 上的科技与 AI 讨论，按发布时间排列，保留作者、票数、评论数与原文链接，英文内容提供中文摘要。',
  },
  'hf-papers': {
    id: 'hf-papers',
    name: 'Hugging Face Daily Papers',
    shortName: 'HF Papers',
    home: 'https://huggingface.co/papers',
    color: '#ffd21e',
    description: '浏览 Hugging Face Daily Papers 的每日论文精选，保留作者、原文链接与中文摘要，帮助快速了解研究内容。',
  },
  simonw: {
    id: 'simonw',
    name: 'Simon Willison',
    shortName: 'Simon Willison',
    home: 'https://simonwillison.net',
    color: '#0f766e',
    description: '浏览 Simon Willison 关于 AI 工具与工程实践的文章，按发布时间排列，保留原文链接并提供中文标题与摘要。',
  },
  'google-ai': {
    id: 'google-ai',
    name: 'Google AI',
    shortName: 'Google AI',
    home: 'https://blog.google/innovation-and-ai/technology/ai/',
    color: '#4285f4',
    description: '浏览 Google AI 官方博客的最新发布，涵盖模型、研究与产品动态，保留原文链接并提供中文标题与摘要。',
  },
  producthunt: {
    id: 'producthunt',
    name: 'Product Hunt',
    shortName: 'Product Hunt',
    home: 'https://www.producthunt.com',
    color: '#da552f',
    description: '浏览 Product Hunt 的每日科技新品，保留产品名称原文、简介与官网链接，中文摘要帮助快速了解产品用途。',
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
