// Creates genuine lab history. Start Precedent first, then run this once.
const base = process.env.BASE || 'http://localhost:3000';
const post = async (path, body = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j;
};
const state = () => fetch(base + '/api/state').then(r => r.json());
await post('/api/lab/up');
for (const [fault, fix] of [['redis-maxclients', 'increase-redis-pool'], ['postgres-connections', 'kill-long-queries'], ['redis-maxclients', 'increase-redis-pool']]) {
  await post(`/api/lab/inject/${fault}`);
  const s = await state(), incident = s.incidents.find(i => i.status === 'open' && i.key === fault);
  if (!incident) throw new Error(`The ${fault} fault was not observed`);
  await post(`/api/triage/${incident.id}`);
  const resolved = await post(`/api/apply/${incident.id}`, { key: fix });
  if (resolved.status !== 'resolved') throw new Error(`${fault} did not recover after ${fix}`);
  console.log(`Bootstrapped ${resolved.id}: ${fix} restored live health.`);
}
