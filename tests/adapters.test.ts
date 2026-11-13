import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchV2ex } from '../src/ingest/adapters/v2ex';
import { fetchNodeseek } from '../src/ingest/adapters/nodeseek';
import { fetchLinuxDo, parseReaderMarkdown } from '../src/ingest/adapters/linuxdo';
import { fetchHn } from '../src/ingest/adapters/hn';
import { fetchGithub } from '../src/ingest/adapters/github';
import { fetchGoogleAi } from '../src/ingest/adapters/google-ai';
import { fetchReddit } from '../src/ingest/adapters/reddit';
import { fetchHuggingFacePapers } from '../src/ingest/adapters/huggingface';
import { fetchProductHunt } from '../src/ingest/adapters/producthunt';
import { fetchSimonW } from '../src/ingest/adapters/simonw';
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
  vi.restoreAllMocks();
});

describe('V2EX adapter', () => {
  it('merges hot and latest, letting live hot metrics win', async () => {
    stubFetch([
      { match: 'api/topics/hot.json', file: 'v2ex-hot.json', type: 'application/json' },
      { match: 'api/topics/latest.json', file: 'v2ex.json', type: 'application/json' },
    ]);
    const items = await fetchV2ex();
    // Three unique latest topics plus one hot-only topic; the duplicated id
    // must not appear twice.
    expect(items).toHaveLength(4);
    expect(new Set(items.map((item) => item.externalId)).size).toBe(4);

    const merged = items.find((item) => item.externalId === '1256220');
    expect(merged?.metrics?.replies).toBe(110);

    const hotOnly = items.find((item) => item.externalId === '9000001');
    expect(hotOnly?.title).toContain('热议');
    expect(hotOnly?.metrics?.replies).toBe(189);

    const first = items[0]!;
    expect(first.source).toBe('v2ex');
    expect(first.externalId).toMatch(/^\d+$/);
    expect(first.title.length).toBeGreaterThan(4);
    expect(first.author).toBeTruthy();
    expect(first.publishedAt).toBeGreaterThan(1_700_000_000_000);
    expect(first.metrics?.replies).toBeGreaterThanOrEqual(0);
    expect(first.url).toMatch(/^https:\/\/www\.v2ex\.com\/t\//);
  });

  it('falls back to latest when the hot endpoint fails', async () => {
    stubFetch([{ match: 'api/topics/latest.json', file: 'v2ex.json', type: 'application/json' }]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await fetchV2ex();
    expect(items).toHaveLength(3);
  });

  it('rejects only when both endpoints fail', async () => {
    stubFetch([]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(fetchV2ex()).rejects.toThrow('V2EX hot and latest both failed');
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

  it('keeps a single original when the RSS contains its thumbnail and srcset sizes', async () => {
    const hash = 'e501efabb23b73adbfd8e2eca3ff2f4532c1ac82';
    const original = `https://cdn3.ldstatic.com/original/4X/e/5/0/${hash}.jpeg`;
    const small = original.replace('/original/', '/optimized/').replace('.jpeg', '_2_287x500.jpeg');
    const large = original.replace('/original/', '/optimized/').replace('.jpeg', '_2_574x1000.jpeg');
    vi.stubGlobal('fetch', async () => new Response(`<rss version="2.0"><channel><item><title>图片测试</title><link>https://linux.do/t/topic/42</link><description><![CDATA[<a href="${original}"><img src="${small}" srcset="${small} 1x, ${large} 2x"></a>]]></description><pubDate>Wed, 11 Nov 2026 11:55:00 +0000</pubDate></item></channel></rss>`));
    expect((await fetchLinuxDo())[0]!.images).toEqual([original]);
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
  const newstories = JSON.parse(fixture('hn-newstories.json')) as number[];
  const topstories = JSON.parse(fixture('hn-topstories.json')) as number[];
  const hnItems = JSON.parse(fixture('hn-items.json')) as Record<number, unknown>;

  function story(id: number, title: string, time: number) {
    return { id, type: 'story', by: 'tester', time, title, score: 10, descendants: 2 };
  }

  /** `null` makes a list endpoint fail; missing item ids 404. */
  function stubHn(routes: {
    newstories?: number[] | null;
    topstories?: number[] | null;
    items?: Record<number, unknown>;
  }): string[] {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.endsWith('/v0/newstories.json')) {
        return routes.newstories ? json(routes.newstories) : new Response('failed', { status: 404 });
      }
      if (url.endsWith('/v0/topstories.json')) {
        return routes.topstories ? json(routes.topstories) : new Response('failed', { status: 404 });
      }
      const match = url.match(/\/v0\/item\/(\d+)\.json$/);
      if (match) {
        const id = Number(match[1]);
        if (routes.items && id in routes.items) return json(routes.items[id]);
        return new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    });
    return urls;
  }

  it('merges new and top stories, dedupes and sorts newest first', async () => {
    const urls = stubHn({ newstories, topstories, items: hnItems });
    const items = await fetchHn();

    expect(items.map((item) => item.externalId)).toEqual([
      '50450003',
      '50450004',
      '50442736',
      '50441707',
    ]);
    expect(urls.filter((url) => url.includes('/v0/item/50441707.json'))).toHaveLength(1);
    expect(urls.some((url) => url.endsWith('/v0/newstories.json'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/v0/topstories.json'))).toBe(true);
  });

  it('maps score, comments, body and the HN item URL fallback', async () => {
    stubHn({ newstories, topstories, items: hnItems });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await fetchHn();

    const link = items.find((item) => item.externalId === '50441707');
    expect(link?.metrics?.points).toBe(904);
    expect(link?.metrics?.comments).toBe(322);
    // The card must link to the discussion even though the story has an
    // external article URL.
    expect(link?.url).toBe('https://news.ycombinator.com/item?id=50441707');
    expect(link?.extra?.hnUrl).toBe('https://news.ycombinator.com/item?id=50441707');

    const self = items.find((item) => item.externalId === '50442736');
    expect(self?.url).toBe('https://news.ycombinator.com/item?id=50442736');
    expect(self?.body).toContain('Previously');
    expect(self?.brief).toBeTruthy();
    expect(self?.extra?.hnUrl).toBe('https://news.ycombinator.com/item?id=50442736');

    const ask = items.find((item) => item.externalId === '50450004');
    expect(ask?.body).toContain('Ask body text');
  });

  it('filters deleted, dead, job and failed items', async () => {
    stubHn({ newstories, topstories, items: hnItems });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await fetchHn();

    expect(items.map((item) => item.externalId).sort()).toEqual([
      '50441707',
      '50442736',
      '50450003',
      '50450004',
    ]);
    // Deleted, dead, job and the 404 item are all skipped.
    expect(warn).toHaveBeenCalled();
  });

  it('caps the lists at 30 new and 40 top ids', async () => {
    const newIds = Array.from({ length: 100 }, (_, index) => index + 1);
    const topIds = Array.from({ length: 100 }, (_, index) => index + 1001);
    const items = Object.fromEntries(
      [...newIds, ...topIds].map((id) => [id, story(id, `s${id}`, id)]),
    );
    const urls = stubHn({ newstories: newIds, topstories: topIds, items });

    const result = await fetchHn();
    expect(result).toHaveLength(70);

    const fetched = urls
      .map((url) => url.match(/\/v0\/item\/(\d+)\.json$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => Number(match[1]));
    expect(new Set(fetched).size).toBe(70);
    expect(fetched).toContain(1);
    expect(fetched).toContain(30);
    expect(fetched).not.toContain(31);
    expect(fetched).toContain(1040);
    expect(fetched).not.toContain(1041);
  });

  it('continues when one list fails', async () => {
    stubHn({ newstories, topstories: null, items: hnItems });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await fetchHn();
    // Only the two valid new-story ids remain.
    expect(items.map((item) => item.externalId).sort()).toEqual(['50441707', '50450003']);
  });

  it('rejects when both lists fail', async () => {
    stubHn({ newstories: null, topstories: null });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(fetchHn()).rejects.toThrow('HTTP 404');
  });

  it('rejects when every story is unusable', async () => {
    stubHn({ newstories: [50450002], topstories: [], items: hnItems });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(fetchHn()).rejects.toThrow('Hacker News returned no stories');
  });
});

describe('GitHub Trending adapter', () => {
  it('parses repository cards and stars today', async () => {
    stubFetch([{ match: 'github.com/trending', file: 'github.html', type: 'text/html' }]);
    // 2026-11-12 16:35 Beijing; the day starts at 2026-11-11T16:00Z.
    const fixedNow = Date.UTC(2026, 10, 12, 8, 35);
    const items = await fetchGithub(fixedNow);
    expect(items).toHaveLength(2);
    const first = items[0]!;
    expect(first.source).toBe('github');
    expect(first.externalId).toContain('/');
    expect(first.metrics?.starsToday).toBeGreaterThan(0);
    expect(first.extra?.lang).toBeTruthy();
    expect(first.url).toBe(`https://github.com/${first.externalId}`);

    // Trending order survives through publishedAt, and the whole block sits
    // inside the current Beijing day instead of tracking "now" on every run.
    const dayStart = Date.UTC(2026, 10, 11, 16, 0);
    expect(items.every((item) => item.publishedAt >= dayStart)).toBe(true);
    expect(items.every((item) => item.publishedAt < fixedNow)).toBe(true);
    expect(first.publishedAt).toBeGreaterThan(items[1]!.publishedAt);
    expect(first.publishedAt - items[1]!.publishedAt).toBe(60_000);
  });

  it('never stamps a repo in the future just after Beijing midnight', async () => {
    stubFetch([{ match: 'github.com/trending', file: 'github.html', type: 'text/html' }]);
    // 2026-11-12 00:00:30 Beijing.
    const fixedNow = Date.UTC(2026, 10, 11, 16, 0, 30);
    const items = await fetchGithub(fixedNow);
    expect(items.every((item) => item.publishedAt < fixedNow)).toBe(true);
    expect(items.every((item) => item.publishedAt >= fixedNow - 60_000)).toBe(true);
  });

  it('keeps stars-today out of the content hash used for edit detection', async () => {
    const now = Date.UTC(2026, 10, 12, 8, 35);
    const load = async (stars: string) => {
      const html = fixture('github.html').replace('3,108 stars today', `${stars} stars today`);
      vi.stubGlobal('fetch', async () => new Response(html, {
        headers: { 'content-type': 'text/html' },
      }));
      return (await fetchGithub(now))[0]!;
    };
    const low = await load('3,108');
    const high = await load('9,999');
    expect(high.metrics?.starsToday).not.toBe(low.metrics?.starsToday);
    expect(high.contentHash).toBe(low.contentHash);
  });
});

describe('X adapter', () => {
  it('combines xbangdan and Tech Twitter while deduplicating status IDs', async () => {
    stubFetch([
      { match: 'xbangdan.com/posts/', file: 'xbangdan-posts.html', type: 'text/html' },
      { match: 'xbangdan.com/hot.json', file: 'xbangdan-hot.json', type: 'application/json' },
      {
        match: 'techtwitter.com/api/tweets/trending',
        file: 'techtwitter-trending.json',
        type: 'application/json',
      },
      {
        match: 'tweet-result?id=2120973994191094179',
        file: 'techtwitter-tweet.json',
        type: 'application/json',
      },
    ]);
    const now = Date.UTC(2026, 10, 13, 20, 0);
    const items = await fetchX(now);

    expect(items).toHaveLength(4);
    expect(new Set(items.map((item) => item.externalId)).size).toBe(4);
    expect(items.some((item) => item.externalId === '2121044759062159705')).toBe(false);

    const xbangdan = items.filter((item) => item.extra?.provider === 'xbangdan');
    expect(xbangdan).toHaveLength(2);
    expect(xbangdan.every((item) => item.extra?.category === 'AI 编程')).toBe(true);
    expect(xbangdan.every((item) => item.extra?.providerLabel === 'X 榜单')).toBe(true);

    const first = xbangdan.find(
      (item) => item.externalId === '2121072773418340838',
    )!;
    expect(first.source).toBe('x');
    expect(first.title).toMatch(/miniMax H3/i);
    expect(first.url).toBe(
      'https://x.com/shangdu2005/status/2121072773418340838',
    );
    expect(first.author).toBe('领哥');
    expect(first.authorHandle).toBe('shangdu2005');
    expect(first.metrics).toEqual({
      views: 257251,
      likes: 319,
      viewsPerHour: 321320,
    });
    expect(first.extra?.corePosts?.[0]).toMatchObject({
      url: first.url,
      handle: 'shangdu2005',
      views: 257251,
      likes: 319,
    });
    expect(first.publishedAt).toBeGreaterThan(Date.UTC(2026, 0, 1));
    expect(first.publishedAt).toBeLessThan(now);

    const tech = items.filter((item) => item.extra?.provider === 'tech-twitter');
    expect(tech).toHaveLength(2);
    expect(tech.every((item) => item.extra?.providerLabel === 'Tech Twitter')).toBe(true);

    const enriched = tech.find((item) => item.externalId === '2120973994191094179')!;
    expect(enriched.title).toBe('Introducing Claude Meetings');
    expect(enriched.body).toContain('builds docs');
    expect(enriched.url).toBe(
      'https://x.com/claudeai/status/2120973994191094179',
    );
    expect(enriched.metrics).toMatchObject({
      likes: 55590,
      replies: 1516,
      qualityScore: 8,
    });
    expect(enriched.images?.some((url) => url.includes('HW82tOPWUAAsEFY'))).toBe(true);
    expect(enriched.extra?.topics).toContain('artificial intelligence');

    const fallback = tech.find((item) => item.externalId === '2121084815101558804')!;
    expect(fallback.title).toContain('Gemini 4 Hydrogen');
    expect(fallback.body).toContain('Artificial Analysis');
    expect(fallback.metrics).toEqual({ qualityScore: 10 });
    expect(fallback.extra?.statsSource).toBe('tech-twitter');
  });

  it('falls back to the server-rendered board when hot.json is unavailable', async () => {
    stubFetch([
      { match: 'xbangdan.com/posts/', file: 'xbangdan-posts.html', type: 'text/html' },
      {
        match: 'techtwitter.com/api/tweets/trending',
        file: 'techtwitter-empty.json',
        type: 'application/json',
      },
    ]);
    const items = await fetchX(Date.UTC(2026, 10, 13, 20, 0));
    expect(items).toHaveLength(2);
    expect(items[0]!.externalId).toBe('2121072773418340838');
    expect(items[0]!.metrics?.likes).toBe(319);
    expect(items[0]!.metrics?.views).toBeUndefined();
  });

  it('keeps Tech Twitter available when both xbangdan boards fail', async () => {
    stubFetch([
      {
        match: 'techtwitter.com/api/tweets/trending',
        file: 'techtwitter-trending.json',
        type: 'application/json',
      },
      {
        match: 'tweet-result?id=2120973994191094179',
        file: 'techtwitter-tweet.json',
        type: 'application/json',
      },
    ]);
    const items = await fetchX(Date.UTC(2026, 10, 13, 20, 0));
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.source === 'x')).toBe(true);
    expect(items.every((item) => item.extra?.provider === 'tech-twitter')).toBe(true);
  });

  it('keeps X 榜单 available when Tech Twitter fails', async () => {
    stubFetch([
      { match: 'xbangdan.com/posts/', file: 'xbangdan-posts.html', type: 'text/html' },
      { match: 'xbangdan.com/hot.json', file: 'xbangdan-hot.json', type: 'application/json' },
    ]);
    const items = await fetchX(Date.UTC(2026, 10, 13, 20, 0));
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.source === 'x')).toBe(true);
    expect(items.every((item) => item.extra?.provider === 'xbangdan')).toBe(true);
  });

  it('rejects when both X providers are unavailable', async () => {
    stubFetch([]);
    await expect(fetchX()).rejects.toThrow(
      'X providers returned no usable posts',
    );
  });
});

describe('Reddit adapter', () => {
  it('maps the multireddit hot feed and keeps its rank as the heat signal', async () => {
    stubFetch([
      {
        match: 'reddit.com/r/programming+technology',
        file: 'reddit.xml',
        type: 'application/atom+xml',
      },
    ]);
    const items = await fetchReddit();
    expect(items).toHaveLength(3);

    const link = items[0]!;
    expect(link.source).toBe('reddit');
    expect(link.externalId).toBe('aaa111');
    expect(link.url).toBe('https://example.com/parser?x=1&y=2');
    expect(link.author).toBe('alice');
    expect(link.metrics?.rank).toBe(1);
    expect(link.extra?.subreddit).toBe('programming');
    expect(link.extra?.redditUrl).toBe(
      'https://www.reddit.com/r/programming/comments/aaa111/tiny_parser/',
    );
    expect(link.images?.[0]).toBe(
      'https://external-preview.redd.it/thumb.jpeg?width=640&crop=smart&s=abc',
    );
    expect(link.body).toBe('');

    const self = items[1]!;
    // Self posts link to their comments page and carry the text in SC_OFF.
    expect(self.url).toBe('https://www.reddit.com/r/webdev/comments/bbb222/free_tiers/');
    expect(self.body).toContain('free tiers handle abuse');
    expect(self.brief).toContain('free tiers handle abuse');
    expect(self.metrics?.rank).toBe(2);

    const share = items[2]!;
    // reddit.com/r/<sub>/s/... share links are not external articles.
    expect(share.url).toBe('https://www.reddit.com/r/webdev/comments/ccc333/update/');
    expect(share.extra?.subreddit).toBe('webdev');
    expect(share.metrics?.rank).toBe(3);
  });

  it('rejects an unexpected payload instead of reporting an empty success', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>blocked</html>', { status: 200 }));
    await expect(fetchReddit()).rejects.toThrow('unexpected feed');
  });
});

describe('AI and product adapters', () => {
  const now = Date.UTC(2026, 10, 13, 20, 0);

  it('maps Hugging Face daily papers and excludes old entries', async () => {
    stubFetch([
      {
        match: 'huggingface.co/api/daily_papers',
        file: 'huggingface-daily.json',
        type: 'application/json',
      },
    ]);
    const items = await fetchHuggingFacePapers(now);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('hf-papers');
    expect(items[0]!.metrics).toEqual({ upvotes: 42, comments: 6 });
    expect(items[0]!.extra?.arxivUrl).toBe('https://arxiv.org/abs/2611.16321');
    expect(items[0]!.images?.some((url) => url.includes('cdn-thumbnails.huggingface.co'))).toBe(true);
  });

  it('keeps upvotes out of the Hugging Face content hash', async () => {
    const load = async (upvotes: number) => {
      const payload = JSON.parse(fixture('huggingface-daily.json')) as Array<{
        paper: { upvotes: number };
      }>;
      payload[0]!.paper.upvotes = upvotes;
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' },
      }));
      return (await fetchHuggingFacePapers(now))[0]!;
    };
    const low = await load(42);
    const high = await load(420);
    expect(high.metrics?.upvotes).toBe(420);
    expect(high.contentHash).toBe(low.contentHash);
  });

  it('keeps only recent AI-tagged Simon Willison entries', async () => {
    stubFetch([
      {
        match: 'simonwillison.net/atom/everything',
        file: 'simonw.xml',
        type: 'application/atom+xml',
      },
    ]);
    const items = await fetchSimonW(now);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('simonw');
    expect(items[0]!.title).toBe('Gemini Decisions API');
    expect(items[0]!.extra?.category).toBe('ai');
  });

  it('parses Google AI summaries, authors and images', async () => {
    stubFetch([
      {
        match: 'blog.google/innovation-and-ai/technology/ai/rss',
        file: 'google-ai.xml',
        type: 'application/rss+xml',
      },
    ]);
    const items = await fetchGoogleAi(now);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('google-ai');
    expect(items[0]!.author).toBe('Example Author');
    expect(items[0]!.extra?.category).toBe('Developer tools');
    expect(items[0]!.body).not.toContain('decorative image alt');
    expect(items[0]!.images?.some((url) => url.includes('storage.googleapis.com'))).toBe(true);
  });

  it('cleans Product Hunt taglines and keeps all recent products', async () => {
    stubFetch([
      {
        match: 'producthunt.com/feed',
        file: 'producthunt.xml',
        type: 'application/atom+xml',
      },
    ]);
    const items = await fetchProductHunt(now);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('producthunt');
    expect(items[0]!.externalId).toBe('youart');
    expect(items[0]!.body).toBe('Codex for creative teams');
    expect(items[0]!.body).not.toContain('Discussion');
  });
});
