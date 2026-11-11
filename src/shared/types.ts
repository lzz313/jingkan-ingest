export const SOURCE_IDS = ['x', 'v2ex', 'nodeseek', 'linuxdo', 'hn', 'github'] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export interface ItemMetrics {
  views?: number;
  likes?: number;
  retweets?: number;
  replies?: number;
  points?: number;
  comments?: number;
  starsToday?: number;
  starsTotal?: number;
  posts?: number;
  participants?: number;
  [key: string]: number | string | undefined;
}

export interface CorePost {
  url: string;
  label?: string;
  handle?: string;
  views?: number;
  likes?: number;
  retweets?: number;
  replies?: number;
}

export interface ItemExtra {
  category?: string;
  node?: string;
  nodeTitle?: string;
  lang?: string;
  corePosts?: CorePost[];
  relatedUrls?: string[];
  hnUrl?: string;
  postsCount?: number;
  participants?: number;
  timeSource?: 'post' | 'rss' | 'trending' | 'digest' | string;
  contextBlocked?: boolean;
  [key: string]: unknown;
}

/** The shape every ingestion adapter must produce. */
export interface NormalizedItem {
  source: SourceId;
  externalId: string;
  storyKey?: string;
  title: string;
  titleZh?: string;
  body?: string;
  brief?: string;
  briefZh?: string;
  url: string;
  author?: string;
  authorHandle?: string;
  publishedAt: number;
  metrics?: ItemMetrics;
  images?: string[];
  extra?: ItemExtra;
  hidden?: boolean;
  contentHash?: string;
}

export interface FeedItem {
  id: string;
  source: SourceId;
  externalId: string;
  storyKey: string | null;
  title: string;
  titleZh: string | null;
  body: string | null;
  brief: string | null;
  briefZh: string | null;
  url: string;
  author: string | null;
  authorHandle: string | null;
  publishedAt: number;
  firstSeenAt: number;
  fetchedAt: number;
  metrics: ItemMetrics;
  hotScore: number;
  isHot: boolean;
  images: string[];
  extra: ItemExtra;
  hidden: boolean;
  contentHash: string | null;
}

export type FeedView = 'latest' | 'hot';

export interface SourceCounts {
  all: number;
  bySource: Partial<Record<SourceId, number>>;
}

export interface FeedResponse {
  items: FeedItem[];
  nextCursor: string | null;
  counts: SourceCounts;
  totals: {
    hot: number;
  };
  lastUpdated: number;
  dataVersion: number;
}

export type ContextPartKind = 'html' | 'text' | 'json';

export interface ContextPart {
  kind: ContextPartKind;
  url?: string;
  content: string;
  truncated?: boolean;
}

export interface ContextResponse {
  item: FeedItem;
  parts: ContextPart[];
  notes: string[];
  blocked: boolean;
}

export interface SourceStatus {
  ok: boolean;
  lastUpdated: number;
  lastError?: string;
}

export interface MetaResponse {
  lastUpdated: number;
  dataVersion: number;
  lastRefreshAt: number;
  sources: Partial<Record<SourceId, SourceStatus>>;
  ai: {
    workersAi: boolean;
    chatModel: string;
    translateModel: string;
  };
}

export interface IngestResponse {
  upserted: number;
  ids: string[];
  dataVersion: number;
  lastUpdated: number;
}

export interface ItemsResponse {
  items: FeedItem[];
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiChatRequest {
  messages: AiMessage[];
  maxTokens?: number;
}

export interface IngestStatus {
  ok: boolean;
  count?: number;
  error?: string;
}

export interface IngestRequest {
  items: NormalizedItem[];
  partial?: boolean;
  sourceStatus?: Partial<Record<SourceId, IngestStatus>>;
}

export interface AdminRecentItem {
  id: string;
  source: SourceId;
  externalId: string;
  title: string;
  body: string | null;
  url: string;
  images: string[];
  publishedAt: number;
  hidden: boolean;
}

export interface MaintenancePatch {
  id: string;
  hidden?: boolean;
  images?: string[];
}

export interface TranslateRequest {
  ids: string[];
  field: 'title' | 'body';
}

export interface TranslateResponse {
  translations: Record<string, string>;
}

export interface BriefResponse {
  briefs: Record<string, string>;
}
