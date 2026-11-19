import { shouldSkipNodeSeekPost } from './nodeseek';
import type { ItemExtra, SourceId } from './types';

const COMMUNITY_SOURCES: SourceId[] = ['v2ex', 'nodeseek', 'linuxdo'];

/**
 * Explicit API-reseller wording. The word `api` inside these phrases used to
 * count as a technical signal, so a pure promotion like "API 中转 限时优惠"
 * survived the filter. The phrase is removed before technical signals are
 * counted, which keeps a genuinely technical post ("开源了一个 API 中转项目，
 * 附部署教程") visible while a promo-only title is hidden.
 */
const RESELLER_TERMS = ['新中转', '中转站', 'api中转', 'api 中转'];

const SPAM_TERMS = [
  ...RESELLER_TERMS,
  '首次亮相',
  '优惠码',
  '邀请码',
  '返利',
  '返佣',
  '限时特惠',
  '限时优惠',
  '折扣码',
  '注册送',
  '充值送',
  '首充',
  '拉新',
  '分销',
  '代理商',
  '招代理',
  '低价机场',
  '机场推荐',
  '月付',
  '年付',
  '八折',
  '8折',
  '五折',
  '5折',
  '白嫖',
  '免费试用',
  '点击购买',
  '购买链接',
  'aff',
  '推广',
];

const TECH_SIGNALS = [
  'github',
  '开源',
  '源码',
  '代码',
  '教程',
  '部署',
  '自建',
  'docker',
  'dockerfile',
  '配置',
  '脚本',
  '插件',
  '算法',
  '论文',
  '模型',
  'api',
  'sdk',
  '文档',
  '更新',
  '发布',
  '修复',
  'bug',
  'issue',
  'huggingface',
  'linux',
  '服务器',
  '数据库',
  '前端',
  '后端',
  'python',
  'typescript',
  'rust',
  'golang',
  '教程向',
];

interface TermMatcher {
  test(text: string): boolean;
}

/**
 * Pure ASCII terms need ASCII word boundaries: a plain substring search makes
 * `aff` match `traffic`, `api` match `rapid`, and `staff` match `sff`-style
 * nonsense. CJK and mixed terms keep substring matching.
 */
function compileTerms(terms: string[]): TermMatcher[] {
  return terms.map((term) => {
    if (/^[a-z0-9]+$/.test(term)) {
      const pattern = new RegExp(`(?<![a-z0-9])${term}(?![a-z0-9])`);
      return { test: (text) => pattern.test(text) };
    }
    return { test: (text) => text.includes(term) };
  });
}

const SPAM_MATCHERS = compileTerms(SPAM_TERMS);
const TECH_MATCHERS = compileTerms(TECH_SIGNALS);

function countMatches(matchers: TermMatcher[], text: string): number {
  return matchers.reduce((total, matcher) => total + (matcher.test(text) ? 1 : 0), 0);
}

// Longest first: removing `中转站` from `api中转站` would otherwise leave a
// bare `api` behind, which the technical-signal pass counts as substance.
const RESELLER_REMOVAL_ORDER = [...RESELLER_TERMS].sort((a, b) => b.length - a.length);

function withoutResellerTerms(text: string): string {
  let result = text;
  for (const term of RESELLER_REMOVAL_ORDER) result = result.split(term).join(' ');
  return result;
}

/** True only when a community post reads like promotion and has no technical substance. */
export function shouldHideItem(item: {
  source: SourceId;
  title: string;
  body?: string | null;
  url?: string;
  extra?: ItemExtra;
}): boolean {
  if (!COMMUNITY_SOURCES.includes(item.source)) return false;
  // The source explicitly categorizes this node as promotion, regardless of technical keywords.
  if (item.source === 'v2ex' && (item.extra?.node?.trim().toLowerCase() === 'promotions' || item.extra?.nodeTitle?.trim() === '推广')) return true;
  // Marketplace/test/invite-code posts are not reading material. This also
  // hides records retained from before the adapter started dropping them.
  if (item.source === 'nodeseek' && shouldSkipNodeSeekPost({ title: item.title, category: item.extra?.category })) return true;
  const text = `${item.title}\n${item.body ?? ''}`;
  const normalized = text.toLowerCase();

  const spamHits = countMatches(SPAM_MATCHERS, normalized);
  if (spamHits === 0) return false;

  const techHits = countMatches(TECH_MATCHERS, withoutResellerTerms(normalized));
  return techHits === 0;
}

export function spamScore(item: { source: SourceId; title: string; body?: string | null }): number {
  if (!COMMUNITY_SOURCES.includes(item.source)) return 0;
  const normalized = `${item.title}\n${item.body ?? ''}`.toLowerCase();
  return countMatches(SPAM_MATCHERS, normalized);
}
