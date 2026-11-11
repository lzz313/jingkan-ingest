import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchV2ex } from '../src/ingest/adapters/v2ex';
import { fetchNodeseek } from '../src/ingest/adapters/nodeseek';
import { fetchLinuxDo, parseReaderMarkdown } from '../src/ingest/adapters/linuxdo';
import { fetchHn } from '../src/ingest/adapters/hn';
import { fetchGithub } from '../src/ingest/adapters/github';
import { fetchX } from '../src/ingest/adapters/x';
import { fixture } from './helpers';

function stubFetch(routes: Array<{ match: string; file: string; type: string }>) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) return new Response('not found', { status: 404 });
    return new Response(fixture(route.file), {
      status: 200,
      headers: { 'content-type': route.type },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('V2EX adapter', () => {
  it('maps topics, bodies and images', async () => {
    stubFetch([{ match: 'api/topics/latest.json', file: 'v2ex.json', type: 'application/json' }]);
    const items = await fetchV2ex();
    expect(items).toHaveLength(3);
    const first = items[0]!;
    expect(first.source).toBe('v2ex');
    expect(first.externalId).toMatch(/^\d+$/);
    expect(first.title.length).toBeGreaterThan(4);
    expect(first.author).toBeTruthy();
    expect(first.publishedAt).toBeGreaterThan(1_700_000_000_000);
    expect(first.metrics?.replies).toBeGreaterThanOrEqual(0);
    expect(first.url).toMatch(/^https:\/\/www\.v2ex\.com\/t\//);
  });
});

describe('NodeSeek adapter', () => {
  it('parses RSS items and merges listing engagement counts', async () => {
    stubFetch([
      { match: 'rss.nodeseek.com', file: 'nodeseek.xml', type: 'application/rss+xml' },
      { match: 'translate.goog', file: 'nodeseek-listing.html', type: 'text/html' },
    ]);
    const items = await fetchNodeseek();
    expect(items).toHaveLength(3);
    expect(items[0]!.source).toBe('nodeseek');
    expect(items[0]!.externalId).toMatch(/^\d+$/);
    expect(items[0]!.extra?.contextBlocked).toBe(true);
    expect(items[0]!.publishedAt).toBeGreaterThan(1_700_000_000_000);
    expect(items[0]!.metrics).toEqual({ views: 1234, comments: 12 });
    expect(items[1]!.metrics).toEqual({ views: 567, comments: 5 });
    expect(items[0]!.extra?.statsSource).toBe('translate-listing');
    expect(items[2]!.metrics).toEqual({});
  });
});

describe('LINUX DO adapter', () => {
  it('parses RSS, reply counts and images', async () => {
    stubFetch([{ match: 'linux.do/latest.rss', file: 'linuxdo.xml', type: 'application/rss+xml' }]);
    const items = await fetchLinuxDo();
    expect(items).toHaveLength(3);
    expect(items[0]!.source).toBe('linuxdo');
    expect(items[0]!.externalId).toMatch(/^\d+$/);
    expect(items[0]!.metrics?.posts).toBeGreaterThanOrEqual(1);
    expect(items[0]!.body).not.toContain('阅读完整话题');
  });

  it('reads English post labels from the Reader XML fallback', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes('r.jina.ai')) return new Response('blocked', { status: 403 });
      return new Response(
        `<rss version="2.0"><channel><title>LINUX DO</title><item>
          <title>Fallback topic</title>
          <link>https://linux.do/t/topic/42</link>
          <description><![CDATA[<p>Hello</p><p><small>3 posts - 2 participants</small></p><p><a>Read full topic</a></p>]]></description>
          <pubDate>Wed, 11 Nov 2026 11:55:00 +0000</pubDate>
          <guid>linux.do-topic-42</guid>
        </item></channel></rss>`,
        { status: 200, headers: { 'content-type': 'application/rss+xml' } },
      );
    });
    const items = await fetchLinuxDo();
    expect(items).toHaveLength(1);
    expect(items[0]!.metrics?.posts).toBe(3);
    expect(items[0]!.metrics?.participants).toBe(2);
    expect(items[0]!.body).not.toContain('Read full topic');
  });

  it('parses the Jina Reader Markdown fallback', () => {
    const items = parseReaderMarkdown(
      [
        'Title: LINUX DO - Latest topics',
        '',
        'Markdown Content:',
        '### [测试标题](https://linux.do/t/topic/3157086)',
        '',
        '[https://linux.do/t/topic/3157086](https://linux.do/t/topic/3157086)  ',
        'Wed, 11 Nov 2026 11:55:00 +0000',
      ].join('\n'),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('linuxdo');
    expect(items[0]!.externalId).toBe('3157086');
    expect(items[0]!.title).toBe('测试标题');
    expect(items[0]!.publishedAt).toBe(Date.parse('Wed, 11 Nov 2026 11:55:00 +0000'));
    expect(items[0]!.extra?.proxy).toBe('jina');
  });
});

describe('Hacker News adapter', () => {
  it('parses Algolia stories and metrics', async () => {
    stubFetch([{ match: 'hn.algolia.com/api/v1/search', file: 'hn.json', type: 'application/json' }]);
    const items = await fetchHn();
    expect(items).toHaveLength(3);
    const first = items[0]!;
    expect(first.source).toBe('hn');
    expect(first.externalId).toMatch(/^\d+$/);
    expect(first.metrics?.points).toBeGreaterThan(0);
    expect(first.metrics?.comments).toBeGreaterThan(0);
    expect(first.extra?.hnUrl).toContain('news.ycombinator.com');
    expect(items.some((item) => item.externalId === '50441707')).toBe(true);
  });
});

describe('GitHub Trending adapter', () => {
  it('parses repository cards and stars today', async () => {
    stubFetch([{ match: 'github.com/trending', file: 'github.html', type: 'text/html' }]);
    const items = await fetchGithub();
    expect(items).toHaveLength(2);
    const first = items[0]!;
    expect(first.source).toBe('github');
    expect(first.externalId).toContain('/');
    expect(first.metrics?.starsToday).toBeGreaterThan(0);
    expect(first.extra?.lang).toBeTruthy();
    expect(first.url).toBe(`https://github.com/${first.externalId}`);
  });
});

describe('X daily report adapter', () => {
  it('parses stories, core posts, metrics and snowflake times', async () => {
    stubFetch([
      { match: '2026-11-11-X', file: 'x-report.html', type: 'text/html' },
      { match: 'aitimeline.news/Daily/', file: 'x-index.html', type: 'text/html' },
    ]);
    const items = await fetchX();
    expect(items.length).toBeGreaterThan(5);
    expect(items.every((item) => (item.extra?.corePosts?.length ?? 0) > 0)).toBe(true);
    expect(items.some((item) => item.externalId === '_1')).toBe(false);
    const first = items[0]!;
    expect(first.source).toBe('x');
    expect(first.title).toContain('Gemini 4 Carbon');
    expect(first.extra?.corePosts?.length).toBeGreaterThan(0);
    expect(first.extra?.relatedUrls?.length).toBeGreaterThan(0);
    expect(first.metrics?.views).toBeGreaterThan(100_000);
    expect(first.publishedAt).toBeGreaterThan(Date.UTC(2026, 0, 1));
    expect(first.publishedAt).toBeLessThan(Date.UTC(2026, 10, 12));
    expect(first.authorHandle).toBe('Google');
  });
});
