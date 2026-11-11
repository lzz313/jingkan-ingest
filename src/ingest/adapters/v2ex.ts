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

export async function fetchV2ex(): Promise<NormalizedItem[]> {
  const topics = await fetchJson<V2exTopic[]>('https://www.v2ex.com/api/topics/latest.json');
  return topics
    .filter((topic) => topic.id && topic.title && topic.url)
    .map((topic) => {
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
    });
}
