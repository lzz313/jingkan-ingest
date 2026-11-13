import { XMLParser } from 'fast-xml-parser';

type XmlValue = unknown;

export interface RssItem {
  title: string;
  link: string;
  description: string;
  creator: string;
  pubDate: string;
  guid: string;
  categories: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  processEntities: true,
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: XmlValue): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const record = value as Record<string, XmlValue>;
    if (typeof record['#text'] === 'string') return record['#text'].trim();
    if (typeof record['#text'] === 'number') return String(record['#text']);
    if (typeof record['@_term'] === 'string') return record['@_term'].trim();
    if (typeof record['@_label'] === 'string') return record['@_label'].trim();
    if (typeof record['@_href'] === 'string') return record['@_href'].trim();
    if ('name' in record) return textOf(record.name);
  }
  return '';
}

function linkOf(value: XmlValue): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, XmlValue>;
    const href = record['@_href'] ?? record['@_url'];
    if (typeof href === 'string') return href.trim();
  }
  return textOf(value);
}

export function parseRss(xml: string): RssItem[] {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const rss = parsed.rss as Record<string, unknown> | undefined;
  const channel = (rss?.channel ?? parsed.channel) as Record<string, unknown> | undefined;
  const feed = parsed.feed as Record<string, unknown> | undefined;
  const root = channel ?? feed;
  if (!root) throw new Error('Not an RSS/Atom document');

  const rawItems = asArray(root.item ?? root.entry);

  return rawItems.map((raw) => {
    const item = raw as Record<string, XmlValue>;
    const guidNode = item.guid;
    const guidRecord =
      guidNode && typeof guidNode === 'object' && !Array.isArray(guidNode)
        ? (guidNode as Record<string, XmlValue>)
        : undefined;

    return {
      title: textOf(item.title),
      link: linkOf(item.link),
      description: textOf(item.description ?? item.summary ?? item.content),
      creator: textOf(item.creator ?? item.author ?? item['dc:creator']),
      pubDate: textOf(item.pubDate ?? item.published ?? item.updated),
      guid: textOf(guidRecord?.['#text'] ?? item.guid ?? item.id),
      categories: asArray(item.category).map(textOf).filter(Boolean),
    };
  });
}

export function parseRssDate(value: string, fallback = Date.now()): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
