import type { IngestStatus, NormalizedItem, SourceId } from '../shared/types';
import { normalizeItem } from '../shared/normalize';
import { fetchGithub } from './adapters/github';
import { fetchGoogleAi } from './adapters/google-ai';
import { fetchHn } from './adapters/hn';
import { fetchHuggingFacePapers } from './adapters/huggingface';
import { fetchLinuxDo } from './adapters/linuxdo';
import { fetchNodeseek } from './adapters/nodeseek';
import { fetchProductHunt } from './adapters/producthunt';
import { fetchReddit } from './adapters/reddit';
import { fetchSimonW } from './adapters/simonw';
import { fetchV2ex } from './adapters/v2ex';
import { fetchX } from './adapters/x';
interface Adapter { source: SourceId; run: () => Promise<NormalizedItem[]> }
const ADAPTERS: Adapter[] = [
  { source: 'x', run: fetchX },
  { source: 'v2ex', run: fetchV2ex },
  { source: 'nodeseek', run: fetchNodeseek },
  { source: 'linuxdo', run: fetchLinuxDo },
  { source: 'hn', run: fetchHn },
  { source: 'github', run: fetchGithub },
  { source: 'reddit', run: fetchReddit },
  { source: 'hf-papers', run: fetchHuggingFacePapers },
  { source: 'simonw', run: fetchSimonW },
  { source: 'google-ai', run: fetchGoogleAi },
  { source: 'producthunt', run: fetchProductHunt },
];

export async function fetchSources(now = Date.now()) {
  const results = await Promise.allSettled(ADAPTERS.map((adapter) => adapter.run()));
  const items: NormalizedItem[] = [];
  const sourceStatus: Partial<Record<SourceId, IngestStatus>> = {};
  for (const [index, result] of results.entries()) {
    const source = ADAPTERS[index]!.source;
    if (result.status === 'rejected') {
      sourceStatus[source] = { ok: false, error: String(result.reason instanceof Error ? result.reason.message : result.reason).slice(0, 300) };
      console.log(`[publish] ${source}: failed`);
      continue;
    }
    const prepared = new Map<string, NormalizedItem>();
    for (const item of result.value) {
      try { const normalized = normalizeItem(item, now); prepared.set(`${normalized.source}:${normalized.externalId}`, normalized); }
      catch { /* A malformed source item must not block its neighbours. */ }
    }
    items.push(...prepared.values());
    sourceStatus[source] = { ok: true, count: prepared.size };
    console.log(`[publish] ${source}: ${prepared.size} items`);
  }
  return { items, sourceStatus };
}
