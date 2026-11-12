import type { NormalizedItem } from '../../shared/types';
import { extractImages, firstSentences, hashText, stripHtml } from '../../shared/html';
import { fetchJson } from '../fetch';

interface V2exTopic {
  id: number;
  title: string;
  url: string;
  content?: string;
  content_rendered?: string;
  created: number;
  replies?: number;
  member?: { username?: string };
  node?: { name?: string; title?: string };
}

const V2EX_HOT_URL = 'https://www.v2ex.com/api/topics/hot.json';
const V2EX_LATEST_URL = 'https://www.v2ex.com/api/topics/latest.json';

function isTopic(topic: V2exTopic | null | undefined): topic is V2exTopic {
  return Boolean(topic && topic.id && topic.title && topic.url);
}

function mapTopic(topic: V2exTopic): NormalizedItem {
  const html = topic.content_rendered || topic.content || '';
  const body = stripHtml(html);
  return {
    source: 'v2ex' as const,
    externalId: String(topic.id),
    title: topic.title,
    body,
    brief: firstSentences(body, 170),
    url: topic.url,
    author: topic.member?.username,
    publishedAt: topic.created * 1000,
    metrics: { replies: topic.replies ?? 0 },
    images: extractImages(html, topic.url),
    extra: {
      node: topic.node?.name,
      nodeTitle: topic.node?.title,
      timeSource: 'post',
    },
    contentHash: hashText(`${topic.title}\n${body}\n${topic.url}`),
  };
}

/**
 * Latest alone freezes a topic's reply count the moment it drops off the front
 * page, which is exactly when it starts climbing the hot list. Fetch both and
 * let hot.json's live metrics win for the topics they share.
 */
export async function fetchV2ex(): Promise<NormalizedItem[]> {
  const [hotResult, latestResult] = await Promise.allSettled([
    fetchJson<V2exTopic[]>(V2EX_HOT_URL),
    fetchJson<V2exTopic[]>(V2EX_LATEST_URL),
  ]);
  if (hotResult.status === 'rejected' && latestResult.status === 'rejected') {
    throw new Error('V2EX hot and latest both failed');
  }
  if (hotResult.status === 'rejected' || latestResult.status === 'rejected') {
    console.warn(
      `V2EX partial fetch: hot=${hotResult.status}, latest=${latestResult.status}`,
    );
  }
  const hot =
    hotResult.status === 'fulfilled' && Array.isArray(hotResult.value) ? hotResult.value : [];
  const latest =
    latestResult.status === 'fulfilled' && Array.isArray(latestResult.value)
      ? latestResult.value
      : [];

  const byId = new Map<string, V2exTopic>();
  for (const topic of latest) {
    if (isTopic(topic)) byId.set(String(topic.id), topic);
  }
  // Hot wins: it carries the current reply count even after the topic left
  // the latest list.
  for (const topic of hot) {
    if (isTopic(topic)) byId.set(String(topic.id), topic);
  }
  return [...byId.values()].map(mapTopic);
}
