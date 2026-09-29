import { FIXES, genericPlaybook } from './catalog.js';
import { chatJSON, llmEnabled } from './llm.js';

const ID_RE = /(?:INC-\d{4}|LAB-[a-z0-9-]+)/gi;
export const buildQuery = a => `${a.service} ${a.service} ${a.title} ${a.logs.join(' ')}`;
export const extractIds = texts => [...new Set(texts.flatMap(t => t.match(ID_RE) || []))];

const fixInfo = key => ({ key, label: FIXES[key]?.label || key, note: FIXES[key]?.note || '', risk: FIXES[key]?.risk || 'med' });
const median = a => { const s = [...a].sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

// ---- Baseline: what an agent WITHOUT memory does ---------------------------------------------
export function baselineBrief(alert, tried = []) {
  const order = genericPlaybook(alert).filter(k => !tried.includes(k));
  return {
    engine: 'generic playbook', noPrecedent: true, confidence: 0.2, etaMinutes: 45,
    summary: 'No history available. Following the standard checklist.',
    probableCause: 'Unknown. Check dashboards, recent deploys and dependency health.',
    actions: order.map((k, i) => ({ ...fixInfo(k), why: i === 0 ? 'Default first step for any unhealthy service.' : 'Next item on the generic checklist.', cites: [] })),
    avoid: [], precedents: [],
  };
}

// ---- Memory-backed brief -----------------------------------------------------------------------
function rulesBrief(alert, ids, history, tried) {
  const byId = Object.fromEntries(history.map(h => [h.id, h]));
  const prec = ids.filter(id => byId[id] && id !== alert.id);
  if (!prec.length) {
    return { ...baselineBrief(alert, tried), engine: 'memory (no precedent)', confidence: 0.15,
      summary: 'No similar incident in memory. Falling back to the generic checklist. Whatever resolves this will be remembered.' };
  }
  const score = {}, cites = {}, mins = {};
  prec.forEach((id, r) => {
    const sim = 1 / (1 + 0.35 * r), h = byId[id];
    for (const w of h.worked) { score[w.key] = (score[w.key] || 0) + sim; (cites[w.key] ||= []).push(id); (mins[w.key] ||= []).push(w.minutes); }
    for (const f of h.failed) { score[f] = (score[f] || 0) - sim * 0.9; (cites[f] ||= []).push(id); }
  });
  const ranked = Object.entries(score).filter(([k]) => !tried.includes(k));
  const good = ranked.filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  const bad = ranked.filter(([, s]) => s < 0).sort((a, b) => a[1] - b[1]);
  const top = byId[prec[0]];
  const conf = good.length ? Math.min(0.95, 0.3 + 0.28 * good[0][1] + 0.08 * (cites[good[0][0]] || []).length) : 0.2;
  const actions = good.map(([k, s]) => ({
    ...fixInfo(k), score: +s.toFixed(2), cites: cites[k],
    why: `Worked in ${cites[k].join(', ')}${mins[k] ? ` (median ${median(mins[k])} min)` : ''}.`,
  }));
  for (const k of genericPlaybook(alert)) if (!tried.includes(k) && !actions.find(a => a.key === k) && !bad.find(([b]) => b === k))
    actions.push({ ...fixInfo(k), why: 'Generic fallback; no precedent either way.', cites: [] });
  return {
    engine: 'memory + rules', noPrecedent: false, confidence: +conf.toFixed(2),
    etaMinutes: good.length ? median(mins[good[0][0]] || [45]) : 45,
    summary: `Looks like ${prec.slice(0, 2).join(' and ')}. ${good.length ? `${fixInfo(good[0][0]).label} resolved it before.` : 'Past fixes were inconclusive.'}`,
    probableCause: `Similar to ${top.id}: ${top.rootCause}`,
    actions,
    avoid: bad.map(([k, s]) => ({ ...fixInfo(k), why: `Failed in ${cites[k].join(', ')}.`, cites: cites[k] })),
    precedents: prec.slice(0, 4).map((id, i) => ({ id, title: byId[id].title, service: byId[id].service, rank: i + 1 })),
  };
}

async function llmBrief(alert, recalled, ids, history, tried) {
  const byId = Object.fromEntries(history.map(h => [h.id, h]));
  const allowed = new Set(ids);
  const sys = `You are Precedent, an on-call incident agent with long-term memory. Use ONLY the memories provided as evidence.
Return ONE JSON object, no prose: {"summary":str,"probable_cause":str,"confidence":0-1,"eta_minutes":int,
"actions":[{"key":str,"why":str,"cites":["INC-####"]}],"avoid":[{"key":str,"why":str,"cites":["INC-####"]}]}
Rules: order actions best-first; put fixes that failed in similar incidents in "avoid"; cite incident IDs from the memories only;
"key" must be one of: ${Object.keys(FIXES).join(', ')}. If memories are not similar, say so and lower confidence.
Do not suggest: ${tried.join(', ') || 'nothing excluded'} (already tried on this incident).`;
  const usr = `ALERT ${alert.id} [${alert.severity}] ${alert.service}: ${alert.title}\nLogs:\n${alert.logs.join('\n')}\n\nMEMORIES:\n${recalled.map((r, i) => `(${i + 1}) ${r.text}`).join('\n')}`;
  const { json, model } = await chatJSON([{ role: 'system', content: sys }, { role: 'user', content: usr }]);
  const clean = list => (list || []).filter(x => FIXES[x.key] && !tried.includes(x.key))
    .map(x => ({ ...fixInfo(x.key), why: String(x.why || ''), cites: (x.cites || []).filter(c => allowed.has(c)) }));
  const actions = clean(json.actions), avoid = clean(json.avoid);
  if (!actions.length) throw new Error('llm returned no valid actions');
  const prec = ids.filter(id => byId[id] && id !== alert.id);
  return {
    engine: `memory + ${model}`, noPrecedent: !prec.length,
    confidence: Math.max(0, Math.min(1, Number(json.confidence) || 0.5)), etaMinutes: Number(json.eta_minutes) || 45,
    summary: String(json.summary || ''), probableCause: String(json.probable_cause || ''),
    actions, avoid,
    precedents: prec.slice(0, 4).map((id, i) => ({ id, title: byId[id].title, service: byId[id].service, rank: i + 1 })),
  };
}

export async function memoryBrief(alert, mem, history, tried = []) {
  const recalled = await mem.recall(buildQuery(alert), 6);
  let ids = extractIds(recalled.map(r => r.text)).filter(id => id !== alert.id);
  if (!ids.length) return { brief: rulesBrief(alert, [], history, tried), recalled };
  let brief;
  if (llmEnabled()) { try { brief = await llmBrief(alert, recalled, ids, history, tried); } catch (e) { console.warn('[llm] falling back to rules:', e.message); } }
  return { brief: brief || rulesBrief(alert, ids, history, tried), recalled };
}

// ---- What the team has learned (computed from the ledger) ---------------------------------------
export function computePatterns(history) {
  const rel = {}, rec = {};
  for (const h of history) {
    for (const w of h.worked) { (rel[w.key] ||= { key: w.key, worked: 0, failed: 0 }).worked++; (rec[`${h.service}|${w.key}`] ||= { service: h.service, key: w.key, ids: [] }).ids.push(h.id); }
    for (const f of h.failed) (rel[f] ||= { key: f, worked: 0, failed: 0 }).failed++;
  }
  return {
    recurring: Object.values(rec).filter(r => r.ids.length >= 2).sort((a, b) => b.ids.length - a.ids.length)
      .map(r => ({ ...r, label: FIXES[r.key]?.label || r.key })),
    reliability: Object.values(rel).map(r => ({ ...r, label: FIXES[r.key]?.label || r.key }))
      .sort((a, b) => (b.worked - b.failed) - (a.worked - a.failed)),
  };
}
