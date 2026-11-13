import type { NormalizedItem } from '../../shared/types';
import { firstSentences, hashText, stripHtml } from '../../shared/html';
import { fetchJson } from '../fetch';
import { isWithinRecentWindow } from '../time-window';

const DAILY_PAPERS_URL = 'https://huggingface.co/api/daily_papers';
const PAPER_BODY_LIMIT = 2_000;

interface HuggingFaceAuthor {
  name?: string;
}

interface HuggingFacePaper {
  id?: string;
  title?: string;
  summary?: string;
  publishedAt?: string;
  submittedOnDailyAt?: string;
  upvotes?: number;
  discussionId?: string;
  githubRepo?: string;
  authors?: HuggingFaceAuthor[];
  submittedOnDailyBy?: { name?: string; fullname?: string; user?: string };
}

interface HuggingFaceDailyPaper {
  paper?: HuggingFacePaper;
  title?: string;
  summary?: string;
  publishedAt?: string;
  thumbnail?: string;
  numComments?: number;
  submittedBy?: { name?: string; fullname?: string; user?: string };
}

function authorName(
  value: HuggingFacePaper['submittedOnDailyBy'] | HuggingFaceDailyPaper['submittedBy'],
): string {
  return value?.fullname || value?.name || value?.user || '';
}

export function parseHuggingFacePapers(
  payload: unknown,
  now = Date.now(),
): NormalizedItem[] {
  if (!Array.isArray(payload)) throw new Error('Hugging Face returned an unexpected payload');
  const items: NormalizedItem[] = [];
  const seen = new Set<string>();

  for (const raw of payload) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as HuggingFaceDailyPaper;
    const paper = entry.paper;
    if (!paper || typeof paper !== 'object') continue;

    const externalId = String(paper.id ?? '').trim();
    const title = stripHtml(paper.title || entry.title);
    const summary = stripHtml(paper.summary || entry.summary);
    const publishedAt = Date.parse(
      paper.submittedOnDailyAt || entry.publishedAt || paper.publishedAt || '',
    );
    if (!externalId || !title || !isWithinRecentWindow(publishedAt, now) || seen.has(externalId)) {
      continue;
    }
    seen.add(externalId);

    const body = summary.slice(0, PAPER_BODY_LIMIT);
    const authors = Array.isArray(paper.authors)
      ? paper.authors.map((author) => author?.name?.trim()).filter(Boolean)
      : [];
    const paperUrl = `https://huggingface.co/papers/${encodeURIComponent(externalId)}`;
    const arxivUrl = `https://arxiv.org/abs/${encodeURIComponent(externalId)}`;
    const thumbnail =
      typeof entry.thumbnail === 'string' && /^https?:\/\//i.test(entry.thumbnail)
        ? entry.thumbnail
        : '';

    items.push({
      source: 'hf-papers',
      externalId,
      title,
      body,
      brief: firstSentences(body, 220),
      url: paperUrl,
      author: authors[0] || authorName(entry.submittedBy) || authorName(paper.submittedOnDailyBy),
      publishedAt,
      metrics: {
        upvotes: Math.max(0, Number(paper.upvotes) || 0),
        comments: Math.max(0, Number(entry.numComments) || 0),
      },
      images: thumbnail ? [thumbnail] : [],
      extra: {
        arxivUrl,
        paperUrl,
        submittedBy: authorName(entry.submittedBy) || authorName(paper.submittedOnDailyBy),
        ...(paper.githubRepo ? { relatedUrls: [paper.githubRepo] } : {}),
        timeSource: 'digest',
      },
      // Upvotes change independently of the paper text; see the R2 state merger
      // throttling rule.
      contentHash: hashText(`${externalId}\n${title}\n${body}`),
    });
  }

  return items;
}

export async function fetchHuggingFacePapers(now = Date.now()): Promise<NormalizedItem[]> {
  const payload = await fetchJson<unknown>(DAILY_PAPERS_URL, {
    headers: { accept: 'application/json' },
  });
  return parseHuggingFacePapers(payload, now);
}
