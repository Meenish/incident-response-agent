import { HindsightClient } from '@vectorize-io/hindsight-client';

const STOP = new Set(['the','and','for','with','after','from','that','this','was','are','has','have','not','did','its','into','than','then','over','all','any','out','our','but','were','been','when','while','which','who','you','your']);
export function tokenize(s) {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || []).filter(t => !STOP.has(t));
}

// ---------------------------------------------------------------------------
// Local fallback: BM25 over incident memories. Same interface as HindsightMemory
// so the app runs offline for development. Hindsight is the real memory layer.
// ---------------------------------------------------------------------------
export class LocalMemory {
  kind = 'local';
  constructor(docs = []) { this.docs = docs; }
  async init() {}
  async retain(text) { this.docs.push({ text, at: new Date().toISOString() }); }
  async retainBatch(texts) { for (const t of texts) await this.retain(t); }
  async recall(query, k = 5) {
    const q = [...new Set(tokenize(query))];
    if (!this.docs.length || !q.length) return [];
    const toks = this.docs.map(d => tokenize(d.text));
    const avgLen = toks.reduce((a, t) => a + t.length, 0) / toks.length;
    const N = this.docs.length;
    const df = {};
    for (const t of toks) for (const w of new Set(t)) df[w] = (df[w] || 0) + 1;
    const k1 = 1.4, b = 0.75;
    const scored = this.docs.map((d, i) => {
      const tf = {};
      for (const w of toks[i]) tf[w] = (tf[w] || 0) + 1;
      let s = 0;
      for (const w of q) {
        if (!tf[w]) continue;
        const idf = Math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5));
        s += idf * (tf[w] * (k1 + 1)) / (tf[w] + k1 * (1 - b + b * toks[i].length / avgLen));
      }
      return { text: d.text, score: s };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0]?.score || 0;
    if (best < 6) return [];                       // nothing genuinely similar
    return scored.filter(r => r.score >= best * 0.4).slice(0, k);
  }
  async reflect() { return null; }
  dump() { return this.docs; }
}

// ---------------------------------------------------------------------------
// Hindsight (Vectorize): retain / recall / reflect against a memory bank.
// ---------------------------------------------------------------------------
export class HindsightMemory {
  kind = 'hindsight';
  constructor({ baseUrl, apiKey, bankId }) {
    this.client = new HindsightClient({ baseUrl, ...(apiKey ? { apiKey } : {}) });
    this.bankId = bankId;
  }
  async init() {
    try {
      await this.client.createBank(this.bankId, {
        name: 'Precedent Docker-lab on-call memory',
        mission: 'You are the institutional memory of an on-call SRE team. Track every incident: symptoms, root cause, ' +
          'which fixes worked and which did NOT work, how long they took, and recurring patterns across services and deploys. ' +
          'Always keep incident IDs (INC-####) attached to what you remember.',
      });
    } catch (e) {
      if (!/exist|already|409/i.test(String(e?.message || e))) throw e;
    }
  }
  async retain(text, ctx = 'incident') {
    await this.client.retain(this.bankId, text, { context: ctx, async: false });
  }
  async retainBatch(texts, ctx = 'incident post-mortem') {
    await this.client.retainBatch(this.bankId, texts.map(content => ({ content, context: ctx })), { async: false });
  }
  async recall(query, k = 6) {
    const r = await this.client.recall(this.bankId, query, { budget: 'mid', maxTokens: 3000 });
    return (r.results || []).slice(0, k).map((x, i) => ({ text: x.text, score: 1 / (1 + i), type: x.type }));
  }
  async reflect(query, context) {
    const r = await this.client.reflect(this.bankId, query, { budget: 'mid', context });
    return r.text;
  }
}
