import { shouldSkipNodeSeekPost } from './nodeseek';
import type { ItemExtra, SourceId } from './types';

const COMMUNITY_SOURCES: SourceId[] = ['v2ex', 'nodeseek', 'linuxdo'];

const SPAM_TERMS = [
  '新中转',
  '中转站',
  'API 中转',
  'api中转',
  'api 中转',
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
  'AFF',
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
  'API',
  'sdk',
  'SDK',
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

  const spamHits = SPAM_TERMS.filter((term) => normalized.includes(term.toLowerCase())).length;
  if (spamHits === 0) return false;

  const techHits = TECH_SIGNALS.filter((term) => normalized.includes(term.toLowerCase())).length;
  return techHits === 0;
}

export function spamScore(item: { source: SourceId; title: string; body?: string | null }): number {
  if (!COMMUNITY_SOURCES.includes(item.source)) return 0;
  const normalized = `${item.title}\n${item.body ?? ''}`.toLowerCase();
  return SPAM_TERMS.filter((term) => normalized.includes(term.toLowerCase())).length;
}
