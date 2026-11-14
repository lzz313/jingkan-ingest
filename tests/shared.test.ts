import { describe, expect, it } from 'vitest';
import { extractImages, firstSentences, hashText, stripHtml } from '../src/shared/html';
import { formatCompactNumber, parseMetricNumber, snowflakeToMs } from '../src/shared/numbers';
import { computeHot } from '../src/shared/scoring';
import { shouldHideItem } from '../src/shared/spam';
import { shouldSkipNodeSeekPost } from '../src/shared/nodeseek';
import { normalizeItem } from '../src/shared/normalize';
import { dayLabel, groupByLocalDay } from '../src/shared/format';

describe('metric parsing', () => {
  it('parses Chinese and Western abbreviations', () => {
    expect(parseMetricNumber('115.7 万')).toBe(1_157_000);
    expect(parseMetricNumber('12.3万')).toBe(123_000);
    expect(parseMetricNumber('3.5k')).toBe(3_500);
    expect(parseMetricNumber('1,234')).toBe(1_234);
    expect(parseMetricNumber('2M')).toBe(2_000_000);
    expect(formatCompactNumber(123_000)).toBe('12.3万');
  });

  it('derives X snowflake timestamps', () => {
    const ms = snowflakeToMs('2120186185423159331');
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(Date.UTC(2026, 0, 1));
    expect(ms!).toBeLessThan(Date.UTC(2026, 10, 12));
    expect(snowflakeToMs('not-a-number')).toBeNull();
  });
});

describe('HTML helpers', () => {
  it('strips tags and decodes entities', () => {
    const text = stripHtml('<p>Hello &amp; 世界</p><p>第二段</p><script>alert(1)</script>');
    expect(text).toContain('Hello & 世界');
    expect(text).toContain('第二段');
    expect(text).not.toContain('alert');
  });

  it('extracts HTML and Markdown images, skips avatars and dedupes', () => {
    const html = `
      <p><img src="/uploads/a.png" alt="a"></p>
      <p><img src="/avatars/user.png"></p>
      <p>![b](https://cdn.example.com/b.jpg)</p>
      <p><img src="https://cdn.example.com/a.png"></p>
    `;
    const images = extractImages(html, 'https://example.com/t/1');
    expect(images).toContain('https://example.com/uploads/a.png');
    expect(images).toContain('https://cdn.example.com/b.jpg');
    expect(images.filter((url) => url.includes('/uploads/a.png'))).toHaveLength(1);
    expect(images.some((url) => url.includes('avatars'))).toBe(false);
  });

  it('truncates at sentence boundaries', () => {
    expect(firstSentences('第一句话。第二句话。', 8)).toBe('第一句话。');
  });

  it('hashes text deterministically', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });
});

describe('spam filter', () => {
  it('hides community promotion without technical substance', () => {
    expect(
      shouldHideItem({
        source: 'v2ex',
        title: '【新中转】限时特惠，注册送额度',
        body: '点击购买，优惠码 ABC',
        url: 'https://www.v2ex.com/t/1',
      }),
    ).toBe(true);
  });

  it('keeps technical posts that mention prices or APIs', () => {
    expect(
      shouldHideItem({
        source: 'v2ex',
        title: '开源了一个 API 中转项目，附部署教程',
        body: 'GitHub 源码和 Docker 配置，欢迎提 issue',
        url: 'https://www.v2ex.com/t/2',
      }),
    ).toBe(false);
  });

  it('does not filter non-community sources', () => {
    expect(
      shouldHideItem({
        source: 'hn',
        title: 'New API startup launches with discount code',
        body: 'promo',
        url: 'https://example.com',
      }),
    ).toBe(false);
  });

  it('hides NodeSeek marketplace, archive, and invite-code posts', () => {
    for (const [title, category] of [
      ['【收】币安实时汇率收100U', 'trade'],
      ['人找车，gemini ultra 5x 20x均可', 'carpool'],
      ['(NQ) 留档 blossomhost 德克萨斯', 'daily'],
      ['Muse 邀请码 & 机器人链接', 'daily'],
      ['剩余+340出 斯巴达 Spartanhost 西雅图', 'daily'],
    ] as const) {
      expect(shouldHideItem({ source: 'nodeseek', title, extra: { category }, url: 'https://www.nodeseek.com/' })).toBe(true);
    }
    expect(
      shouldHideItem({ source: 'nodeseek', title: '今晚的 po0 是怎么了？', extra: { category: 'daily' }, url: 'https://www.nodeseek.com/' }),
    ).toBe(false);
  });
});

describe('NodeSeek post policy', () => {
  it('drops trade and carpool nodes', () => {
    expect(shouldSkipNodeSeekPost({ title: '随便什么标题', category: 'trade' })).toBe(true);
    expect(shouldSkipNodeSeekPost({ title: '人找车', category: 'CARPOOL' })).toBe(true);
  });

  it('drops test archives, invite codes, and misplaced sales titles', () => {
    for (const title of [
      '(NQ) 留档 blossomhost 测试',
      'Muse 邀请码 & 机器人链接',
      '【收】币安实时汇率收100U',
      '[出] 50 出 年付 $4.8 V6VPS',
      '+500收corona',
      '剩余+340出 斯巴达 Spartanhost',
    ]) {
      expect(shouldSkipNodeSeekPost({ title, category: 'daily' })).toBe(true);
    }
  });

  it('keeps ordinary posts', () => {
    for (const title of ['今晚的 po0 是怎么了？', '老鸡晚高峰新测 TQ Lightlayer SJ-VP04-L', 'DMIT 行业资讯']) {
      expect(shouldSkipNodeSeekPost({ title, category: 'daily' })).toBe(false);
    }
  });
});

describe('hot scoring', () => {
  it('applies per-source thresholds', () => {
    expect(computeHot('v2ex', { replies: 19 }).isHot).toBe(false);
    expect(computeHot('v2ex', { replies: 20 }).isHot).toBe(true);
    expect(computeHot('hn', { points: 30, comments: 0 }).isHot).toBe(true);
    expect(computeHot('github', { starsToday: 100 }).isHot).toBe(true);
    expect(computeHot('nodeseek', {}).isHot).toBe(false);
    expect(computeHot('nodeseek', { comments: 5 }).isHot).toBe(false);
    expect(computeHot('nodeseek', { comments: 5 }).score).toBeGreaterThan(0);
    expect(computeHot('nodeseek', { comments: 10 }).isHot).toBe(true);
    expect(computeHot('hf-papers', { upvotes: 24, comments: 4 }).isHot).toBe(false);
    expect(computeHot('hf-papers', { upvotes: 25, comments: 0 }).isHot).toBe(true);
    expect(computeHot('hf-papers', { upvotes: 1, comments: 5 }).isHot).toBe(true);
  });

  it('normalizes scores into a comparable range', () => {
    const v2ex = computeHot('v2ex', { replies: 200 });
    const github = computeHot('github', { starsToday: 5000 });
    expect(v2ex.score).toBeGreaterThanOrEqual(50);
    expect(github.score).toBeLessThanOrEqual(100);
    expect(github.score).toBeGreaterThan(v2ex.score);
    expect(computeHot('github', { starsToday: 100 }).score).toBe(40);
    expect(computeHot('v2ex', { replies: 5 }).score).toBeGreaterThan(0);
    expect(computeHot('linuxdo', { posts: 2 }).score).toBeGreaterThan(0);
  });
});

describe('normalization', () => {
  it('strips HTML, extracts images and computes hidden/content hash', () => {
    const item = normalizeItem({
      source: 'linuxdo',
      externalId: '123',
      title: '测试标题',
      body: '<p>正文 <img src="https://cdn3.ldstatic.com/a.png"></p>',
      url: 'https://linux.do/t/topic/123',
      publishedAt: Date.now() - 1000,
      metrics: { posts: 3 },
    });
    expect(item.body).toContain('正文');
    expect(item.images).toContain('https://cdn3.ldstatic.com/a.png');
    expect(item.contentHash).toBeTruthy();
    expect(item.publishedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('date grouping', () => {
  it('groups by local day and labels today', () => {
    const now = Date.now();
    const groups = groupByLocalDay([
      { publishedAt: now, id: 1 },
      { publishedAt: now - 86_400_000, id: 2 },
    ], now);
    expect(groups[0]!.label).toBe('今天');
    expect(groups[1]!.label).toBe('昨天');
    expect(dayLabel(now, now)).toBe('今天');
  });
});
