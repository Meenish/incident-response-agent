import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalMemory, HindsightMemory } from './lib/memory.js';
import { baselineBrief, memoryBrief, computePatterns } from './lib/agent.js';
import { llmName } from './lib/llm.js';
import { FIXES } from './lib/catalog.js';
import { DockerLab } from './lib/lab.js';

// const __dir = path.dirname(fileURLToPath(import.meta.url)), STATE_FILE = path.join(__dir, 'data', 'state.json');
const __dir = path.dirname(fileURLToPath(import.meta.url)),
      STATE_FILE = process.env.VERCEL
        ? '/tmp/state.json'
        : path.join(__dir, 'data', 'state.json');
const PORT = process.env.PORT || 3000, USE_HINDSIGHT = !!process.env.HINDSIGHT_BASE_URL;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let S, mem, lab = new DockerLab(), seeding = false, seedError = null;
const fresh = () => ({ version: 2, bankId: `${process.env.HINDSIGHT_BANK || 'precedent-oncall'}-${Date.now().toString(36)}`, seeded: false, history: [], incidents: [], stats: [], log: [], localDocs: [] });
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(S));
const log = (kind, text) => { S.log.push({ t: new Date().toISOString(), kind, text }); S.log = S.log.slice(-60); };
const memoryText = h => `Incident ${h.id} on ${h.service} (${h.severity}, ${h.date}): ${h.title}. Symptoms in logs: ${h.logs.join(' | ')}. Root cause: ${h.rootCause} Fix that worked: ${h.worked.map(w => `${w.key} (resolved it in ${w.minutes} min)`).join('; ') || 'none'}. Attempted but did NOT work: ${h.failed.join(', ') || 'none'}.`;
async function boot(reset = false) {
  if (!reset && fs.existsSync(STATE_FILE)) try { S = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  if (!S || reset || S.version !== 2) S = fresh();
  if (USE_HINDSIGHT) mem = new HindsightMemory({ baseUrl: process.env.HINDSIGHT_BASE_URL, apiKey: process.env.HINDSIGHT_API_KEY, bankId: S.bankId });
  else { mem = new LocalMemory(S.localDocs); S.seeded = true; }
  if (USE_HINDSIGHT && !S.seeded) seed(); save();
}
async function seed() { seeding = true; seedError = null; try { await mem.init(); if (S.history.length) await mem.retainBatch(S.history.map(memoryText)); S.seeded = true; log('retain', 'Hindsight connected; its initial history contains only real Docker-lab outcomes.'); save(); } catch (e) { seedError = String(e.message || e); } finally { seeding = false; } }
const ready = () => S.seeded && !seeding;
let lastObserve = 0, observing = null;
async function observe(force = false) { if (observing) return observing; if (!force && Date.now() - lastObserve < 2500) return; observing = observeNow().finally(() => { observing = null; lastObserve = Date.now(); }); return observing; }
async function observeNow() { const detected = await lab.observe();
  if (!detected.length) for (const i of S.incidents) if (i.status === 'open' && (i.key === 'lab-unavailable' || i.key === 'dependency-unhealthy')) { i.status = 'resolved'; i.resolvedMinutes = 0; } for (const next of detected) { const existing = S.incidents.find(i => i.key === next.key && i.status === 'open'); if (existing) Object.assign(existing, { logs: next.logs, title: next.title }); else { next.id = `${next.id}-${Date.now().toString(36)}`; next.openedAt = new Date().toISOString(); S.incidents.unshift(next); log('alert', `${next.id}: detected from Docker health/log output`); } } save(); }
const DEP = { 'redis-maxclients': 'redis', 'postgres-connections': 'postgres' };
// Judge a fix by the dependency it targets, so fixing Redis isn't marked "failed" just because Postgres is still down.
async function recovery(key) { for (let sample = 1; sample <= 8; sample++) { const h = await lab.health().catch(() => ({ ok: false, body: {} })), dep = DEP[key]; if (h.ok || (dep && !(h.body.failed || []).some(f => f.dependency === dep) && (h.body.failed || []).length)) return { ok: true, samples: sample }; await wait(1250); } return { ok: false, samples: 8 }; }

const app = express(); app.use(express.json()); app.use(express.static(path.join(__dir, 'public')));
app.get('/api/state', async (_q, res) => { await observe(); res.json({ backend: { memory: mem.kind, bankId: USE_HINDSIGHT ? S.bankId : null, llm: llmName(), ready: ready(), seeding, seedError, source: 'local Docker lab' }, incidents: S.incidents, stats: S.stats, history: S.history, patterns: computePatterns(S.history), log: S.log.slice(-25).reverse() }); });
app.post('/api/lab/up', async (_q, res) => { try { await lab.up(); log('lab', 'Docker lab started'); await observe(true); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); } });
app.post('/api/lab/inject/:fault', async (req, res) => { try { await lab.inject(req.params.fault); log('lab', `Injected real ${req.params.fault} fault`); await wait(1500); await observe(true); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); } });
app.post('/api/triage/:id', async (req, res) => { const inc = S.incidents.find(i => i.id === req.params.id); if (!inc) return res.status(404).json({ error: 'unknown live incident' }); if (!ready()) return res.status(503).json({ error: seedError || 'memory is loading' }); try { const tried = inc.attempts.map(a => a.key), { brief, recalled } = await memoryBrief(inc, mem, S.history, tried), baseline = baselineBrief(inc, tried); inc.brief = { memory: brief, baseline }; inc.recalled = recalled.slice(0, 4).map(r => r.text); if (!inc.first) inc.first = { memory: brief.actions[0]?.key, baseline: baseline.actions[0]?.key, memConf: brief.confidence, memEta: brief.etaMinutes }; log('recall', `${inc.id}: recalled ${recalled.length} real incidents`); save(); res.json(inc); } catch (e) { res.status(500).json({ error: String(e.message || e) }); } });
app.post('/api/apply/:id', async (req, res) => { const inc = S.incidents.find(i => i.id === req.params.id), key = req.body?.key; if (!inc || !FIXES[key]) return res.status(400).json({ error: 'bad request' }); if (inc.status === 'resolved') return res.status(409).json({ error: 'already resolved' }); try { await lab.apply(key); const measured = await recovery(inc.key), at = new Date().toISOString(); inc.attempts.push({ key, outcome: measured.ok ? 'worked' : 'failed', at, measured }); if (!measured.ok) { await mem.retain(`Outcome for ${inc.id}: executable remediation ${key} did NOT restore the live health check. Symptoms: ${inc.logs.join(' | ')}`, 'failed remediation'); log('retain', `${inc.id}: ${key} executed; health remained failed`); } else { inc.status = 'resolved'; inc.resolvedMinutes = Math.max(1, Math.ceil((Date.now() - Date.parse(inc.openedAt)) / 60000)); const entry = { id: inc.id, date: at.slice(0, 10), severity: inc.severity, service: inc.service, owner: 'docker-lab', title: inc.title, logs: inc.logs, rootCause: inc.cause, worked: [{ key, minutes: inc.resolvedMinutes }], failed: inc.attempts.filter(a => a.outcome === 'failed').map(a => a.key), minutes: inc.resolvedMinutes }; S.history.push(entry); await mem.retain(memoryText(entry), 'resolved Docker-lab incident'); S.stats.push({ id: inc.id, service: inc.service, memoryHit: inc.first?.memory === key, baselineHit: inc.first?.baseline === key, confidence: inc.first?.memConf, actual: inc.resolvedMinutes, baselineEta: 45, memoryEta: inc.first?.memEta }); log('retain', `${inc.id}: recovery measured after ${key}; post-mortem retained`); } if (mem.kind === 'local') S.localDocs = mem.dump(); save(); res.json(inc); } catch (e) { res.status(500).json({ error: String(e.message || e) }); } });
app.post('/api/reflect', async (_q, res) => { try { const text = await mem.reflect('Across real Docker-lab incidents, what recurring failures and successful remediations exist?', 'weekly review'); if (text) log('reflect', 'Hindsight reflected across real lab incidents'); save(); res.json({ text }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); } });
app.post('/api/reset', async (_q, res) => { await boot(true); res.json({ ok: true }); });
await boot(); app.listen(PORT, () => console.log(`Precedent running → http://localhost:${PORT} (source: local Docker lab)`));
