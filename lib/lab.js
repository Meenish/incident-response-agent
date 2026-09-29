import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const composeFile = fileURLToPath(new URL('../docker-compose.yml', import.meta.url));
const compose = (...args) => run('docker', ['compose', '-f', composeFile, ...args]);
const composeSlow = (...args) => run('docker', ['compose', '-f', composeFile, ...args], 600000); // first image pull/build can take minutes
const run = (cmd, args, timeout = 20000) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { windowsHide: true }); let out = '', err = '';
  const timer = setTimeout(() => { p.kill(); reject(new Error(`${cmd} timed out`)); }, timeout);
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  p.on('error', reject); p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} exited ${code}`)); });
});
const checkout = (path, method = 'GET') => fetch(`http://127.0.0.1:8080${path}`, { method, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000) });
export const LAB_FIXES = {
  'increase-redis-pool': { label: 'Raise Redis maxclients / pool size', risk: 'low', note: 'Restores Redis capacity, then clears the fault clients.' },
  'kill-long-queries': { label: 'Terminate long-running queries', risk: 'med', note: 'Terminates the actual pg_sleep sessions holding database slots.' },
  'restart-service': { label: 'Restart checkout service', risk: 'low', note: 'Restarts the actual checkout container.' },
};
export class DockerLab {
  async up() {
    await composeSlow('up', '-d', '--build');
    for (let i = 0; i < 40; i++) { if ((await this.health().catch(() => null))?.ok) return; await new Promise(r => setTimeout(r, 1500)); }
    throw new Error('Docker lab started but /health did not turn green within 60s. Run `docker compose logs` to see why.');
  }
  async health() { const r = await checkout('/health'); return { ok: r.ok, body: await r.json().catch(() => ({})) }; }
  async logs(dep) {
    const text = await compose('logs', '--tail', '60', 'checkout'), lines = text.split(/\r?\n/).filter(Boolean);
    const own = dep ? lines.filter(l => l.toLowerCase().includes(dep)) : [];
    return (own.length ? own : lines).slice(-6);
  }
  async observe() {
    try {
      const health = await this.health(); if (health.ok) return [];
      const deps = (health.body.failed || []).map(f => f.dependency), out = [];
      if (deps.includes('redis')) out.push(this.incident('redis-maxclients', 'SEV2', 'checkout-api', 'checkout-api is failing fresh Redis connections', await this.logs('redis'), 'Redis maxclients is exhausted by real client sockets.'));
      if (deps.includes('postgres')) out.push(this.incident('postgres-connections', 'SEV2', 'postgres-primary', 'checkout-api is being refused by Postgres', await this.logs('postgres'), 'Postgres connection slots are exhausted by long-running sessions.'));
      return out.length ? out : [this.incident('dependency-unhealthy', 'SEV3', 'checkout-api', 'checkout-api dependency health check is failing', await this.logs(), 'A live dependency health check is failing.')];
    } catch (e) { return [this.incident('lab-unavailable', 'SEV3', 'docker-lab', 'Docker lab is not reachable', [String(e.message || e)], 'The local Docker lab is unavailable.')]; }
  }
  incident(key, severity, service, title, logs, cause) { return { id: `LAB-${key}`, key, severity, service, title, logs, cause, status: 'open', attempts: [], brief: null, first: null }; }
  async inject(key) { if (key === 'redis-maxclients') return checkout('/fault/redis-exhaust', 'POST'); if (key === 'postgres-connections') return checkout('/fault/postgres-exhaust', 'POST'); throw new Error('unknown lab fault'); }
  async apply(key) {
    if (key === 'increase-redis-pool') { await checkout('/fault/clear-local', 'POST'); /* free the slots first: redis-cli itself needs a client slot */ await compose('exec', '-T', 'redis', 'redis-cli', 'CONFIG', 'SET', 'maxclients', '1000'); return; }
    if (key === 'kill-long-queries') {
      // psql needs a free connection slot, and the fault has used them all. Retry a few times
      // (a slot can free up between health probes), then fall back to releasing the fault clients.
      const sql = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep%' AND pid <> pg_backend_pid();";
      const term = () => compose('exec', '-T', 'postgres', 'psql', '-U', 'precedent', '-d', 'precedent', '-c', sql);
      let done = false;
      for (let i = 0; i < 4 && !done; i++) { try { await term(); done = true; } catch { await new Promise(r => setTimeout(r, 700)); } }
      await checkout('/fault/clear-local', 'POST').catch(() => {});
      if (!done) await term();
      return;
    }
    if (key === 'restart-service') return compose('restart', 'checkout');
    throw new Error(`No executable lab remediation for ${key}`);
  }
}
