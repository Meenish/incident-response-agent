// A live walkthrough, not a fixture replay. Requires Docker Desktop and npm start.
const base = process.env.BASE || 'http://localhost:3000';
const post = async (path, body = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j;
};
const state = () => fetch(base + '/api/state').then(r => r.json());
await post('/api/lab/up');
for (const fault of ['redis-maxclients', 'postgres-connections']) {
  await post(`/api/lab/inject/${fault}`); const s = await state();
  const inc = s.incidents.find(x => x.key === fault && x.status === 'open');
  const triaged = await post(`/api/triage/${inc.id}`);
  const action = triaged.brief.memory.actions[0];
  console.log(`${inc.id}: ${action.key} — ${action.why || 'no previous evidence yet'}`);
  const after = await post(`/api/apply/${inc.id}`, { key: action.key });
  console.log(`  executed; measured outcome: ${after.attempts.at(-1).outcome}`);
}
