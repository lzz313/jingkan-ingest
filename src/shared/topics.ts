import type { FeedItem, SourceId } from './types';

export const TOPIC_IDS = [
  'ai',
  'open-source',
  'dev-tools',
  'infra',
  'products',
] as const;

export type TopicId = (typeof TOPIC_IDS)[number];

export interface TopicMeta {
  id: TopicId;
  name: string;
  shortName: string;
  headline: string;
  description: string;
  keywords: string;
  color: string;
  primarySources: readonly SourceId[];
  /** Patterns checked against title + translated title + summary + URL/extra tags. */
  pattern: RegExp;
}

export const TOPICS: Record<TopicId, TopicMeta> = {
  ai: {
    id: 'ai',
    name: 'AI 与大模型',
    shortName: 'AI 大模型',
    headline: 'AI 与大模型最新动态、论文与 Agent 工程实践',
    description:
      '跨源聚合 X、Hacker News、GitHub Trending、Hugging Face Daily Papers、Google AI 与 Simon Willison 的 AI 模型、智能体与论文动态，提供中文摘要与原文直达。',
    keywords: 'AI 动态,大模型,LLM,AI Agent,Hugging Face 论文,Google AI,OpenAI,Claude,Gemini,DeepSeek,静show,jing.show',
    color: '#2563eb',
    primarySources: ['hf-papers', 'google-ai', 'simonw'],
    pattern:
      /\b(ai|agi|llm|llms|gpt-?\d*|chatgpt|claude|gemini|deepseek|qwen|openai|anthropic|mistral|llama|agent|agents|agentic|mcp|rag|vllm|ollama|cursor|codex|copilot|diffusion|transformer|huggingface|hugging face|midjourney|sora|neural|embedding|embeddings|inference|fine-?tun\w*|benchmark|multimodal|reasoning model)\b|大模型|人工智能|智能体|多模态|推理模型|提示词|微调|向量库|算力|生图|生视频|神经网络|机器学习|深度学习|论文/i,
  },
  'open-source': {
    id: 'open-source',
    name: '开源项目',
    shortName: '开源项目',
    headline: '热门开源项目、GitHub 趋势仓库与自托管工具',
    description:
      '汇总 GitHub Trending 与技术社区热议的开源仓库、框架发布与自托管项目，附中文简介、技术栈与仓库原文链接。',
    keywords: '开源项目,GitHub Trending,GitHub 热门仓库,开源工具,自托管,Open Source,静show,jing.show',
    color: '#0f766e',
    primarySources: ['github'],
    pattern:
      /\b(open[\s-]?source|github\.com\/|gitlab\.com\/|foss|oss|self[\s-]?hosted|mit license|apache[\s-]?2|gplv?\d|show hn|changelog|release notes?)\b|开源|自托管|仓库|源码|源代码|开源项目|开源替代/i,
  },
  'dev-tools': {
    id: 'dev-tools',
    name: '开发者工具与编程',
    shortName: '开发工具',
    headline: '编程语言、IDE、数据库与开发者工程工具',
    description:
      '聚合 Rust、TypeScript、Python、Go、SQLite、PostgreSQL、编辑器、CLI 与前后端架构相关的热门技术讨论与实践文章。',
    keywords: '开发者工具,编程语言,Rust,TypeScript,Python,Go,数据库,CLI,IDE,前端,后端,静show,jing.show',
    color: '#7c3aed',
    primarySources: ['hn', 'github', 'simonw'],
    pattern:
      /\b(rust|typescript|javascript|python|golang|zig|swift|kotlin|react|vue|svelte|next\.?js|vite|preact|node\.?js|deno|bun|sqlite|postgres|postgresql|mysql|redis|clickhouse|duckdb|cli|ide|vscode|vs code|neovim|vim|emacs|git|wasm|webassembly|compiler|runtime|sdk|graphql|terminal|ghostty|zed|debugger|linter|bundler)\b|编程语言|编译器|数据库|前端|后端|全栈|脚手架|命令行|终端|开发工具|调试|架构|框架|插件|代码/i,
  },
  infra: {
    id: 'infra',
    name: '云计算与网络基建',
    shortName: '云与基建',
    headline: '云服务器、VPS、Linux、运维与网络安全动态',
    description:
      '追踪 NodeSeek、V2EX、Hacker News 等社区关于云服务器、Cloudflare、Docker、Kubernetes、Linux、自建服务与网络安全的实用讨论。',
    keywords: '云服务器,VPS,Cloudflare,Linux,Docker,Kubernetes,网络安全,运维,自建服务,NodeSeek,静show,jing.show',
    color: '#0369a1',
    primarySources: ['nodeseek'],
    pattern:
      /\b(cloudflare|aws|gcp|azure|vps|linux|ubuntu|debian|nixos|arch linux|docker|kubernetes|k8s|nginx|caddy|dns|bgp|cdn|ssl|tls|ssh|vpn|wireguard|tailscale|ipv6|cve-\d+|zero-?day|homelab|nas|r2|s3|terraform|prometheus|grafana|firewall|proxy|reverse proxy)\b|服务器|云计算|云原生|运维|建站|自建|网络安全|防火墙|漏洞|加密|代理|内网穿透|容器|集群|存储|带宽|线路|机房/i,
  },
  products: {
    id: 'products',
    name: '科技新品与效率应用',
    shortName: '科技新品',
    headline: 'Product Hunt 每日新品、独立产品与效率应用',
    description:
      '精选 Product Hunt 每日上线新品与各社区热议的独立开发工具、macOS / iOS 应用、浏览器插件与效率软件，附中文简介与直达链接。',
    keywords: '科技新品,Product Hunt,独立开发,效率工具,macOS 应用,SaaS,AI 应用,静show,jing.show',
    color: '#c2410c',
    primarySources: ['producthunt'],
    pattern:
      /\b(product hunt|saas|indie|macos|ios|iphone|ipad|android|chrome extension|browser|raycast|obsidian|notion|figma|linear|arc browser|desktop app|mobile app|productivity)\b|新品|独立开发|效率工具|客户端|桌面端|浏览器|笔记工具|工作流|应用推荐|上线|产品/i,
  },
};

export function isTopicId(value: unknown): value is TopicId {
  return typeof value === 'string' && (TOPIC_IDS as readonly string[]).includes(value);
}

export function topicPath(topic: TopicId): string {
  return `/topic/${topic}`;
}

export type TopicMatchableItem = Pick<
  FeedItem,
  'source' | 'title' | 'titleZh' | 'brief' | 'briefZh' | 'url' | 'extra'
>;

function itemSearchText(item: TopicMatchableItem): string {
  const parts: string[] = [item.title];
  if (item.titleZh) parts.push(item.titleZh);
  if (item.briefZh) parts.push(item.briefZh);
  else if (item.brief) parts.push(item.brief);
  if (item.url) parts.push(item.url.replace(/^https?:\/\//i, ''));
  const extra = item.extra ?? {};
  for (const key of ['lang', 'nodeTitle', 'category', 'subreddit', 'tags'] as const) {
    const val = extra[key];
    if (typeof val === 'string' && val.trim()) parts.push(val.trim());
  }
  return parts.join(' ');
}

export function matchesTopic(item: TopicMatchableItem, topic: TopicId): boolean {
  const meta = TOPICS[topic];
  // Strict primary-source affinity only for sources dedicated to that topic.
  if (
    (topic === 'ai' && (item.source === 'hf-papers' || item.source === 'google-ai' || item.source === 'simonw')) ||
    (topic === 'open-source' && item.source === 'github') ||
    (topic === 'infra' && item.source === 'nodeseek') ||
    (topic === 'products' && item.source === 'producthunt')
  ) {
    return true;
  }
  return meta.pattern.test(itemSearchText(item));
}

export function itemTopics(item: TopicMatchableItem): TopicId[] {
  const text = itemSearchText(item);
  const matched: TopicId[] = [];
  for (const id of TOPIC_IDS) {
    if (
      (id === 'ai' && (item.source === 'hf-papers' || item.source === 'google-ai' || item.source === 'simonw')) ||
      (id === 'open-source' && item.source === 'github') ||
      (id === 'infra' && item.source === 'nodeseek') ||
      (id === 'products' && item.source === 'producthunt') ||
      TOPICS[id].pattern.test(text)
    ) {
      matched.push(id);
    }
  }
  return matched;
}
