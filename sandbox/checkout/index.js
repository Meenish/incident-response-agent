import express from 'express';
import { createClient } from 'redis';
import pg from 'pg';

const app = express(); app.use(express.json());
const redisUrl = process.env.REDIS_URL, dbUrl = process.env.DATABASE_URL;
let redisHolders = [], pgHolders = [];
const log = (event, extra = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), service: 'checkout-api', event, ...extra }));
// node-redis emits `error` on a socket that is intentionally closed during a
// probe. An error listener keeps that expected transport event from crashing
// the whole checkout process.
const redisClient = options => { const c = createClient({ ...options, socket: { reconnectStrategy: false, connectTimeout: 1200, ...(options.socket || {}) } }); c.on('error', error => log('redis_socket_error', { error: error.message })); return c; };
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} probe timed out`)), ms))]);
async function redisProbe() { const c = redisClient({ url: redisUrl }); try { await c.connect(); await c.ping(); } finally { await c.quit().catch(() => c.disconnect()); } }
async function pgProbe() { const p = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 1200 }); try { await p.connect(); await p.query('select 1'); } finally { await p.end().catch(() => {}); } }
app.get('/health', async (_req, res) => {
  const checks = await Promise.allSettled([within(redisProbe(), 3000, 'redis'), within(pgProbe(), 3000, 'postgres')]);
  const failed = checks.map((x, i) => x.status === 'rejected' ? { dependency: i ? 'postgres' : 'redis', error: String(x.reason.message || x.reason) } : null).filter(Boolean);
  if (failed.length) { failed.forEach(x => log('dependency_health_failed', x)); return res.status(503).json({ ok: false, failed }); }
  log('health_ok'); res.json({ ok: true });
});
app.get('/status', (_req, res) => res.json({ redisHolders: redisHolders.length, pgHolders: pgHolders.length }));
app.post('/fault/redis-exhaust', async (_req, res) => {
  const admin = redisClient({ url: redisUrl }); await admin.connect(); await admin.configSet('maxclients', '8');
  for (let i = 0; i < 12; i++) { const c = redisClient({ url: redisUrl }); try { await c.connect(); redisHolders.push(c); } catch (e) { log('redis_client_exhausted', { error: e.message }); } }
  await admin.quit();
  // The admin connection just freed a slot: take it too, so every slot is held and health really fails.
  for (let i = 0; i < 3; i++) { const c = redisClient({ url: redisUrl }); try { await c.connect(); redisHolders.push(c); } catch (e) { break; } }
  log('redis_maxclients_exhausted', { maxclients: 8, holders: redisHolders.length }); res.json({ ok: true, holders: redisHolders.length });
});
app.post('/fault/postgres-exhaust', async (_req, res) => {
  if (pgHolders.length >= 20) return res.json({ ok: true, holders: pgHolders.length, already: true });
  for (let i = 0; i < 40; i++) {
    const c = new pg.Client({ connectionString: dbUrl }); c.on('error', () => {}); // a terminated backend must not crash the process
    try { await c.connect(); pgHolders.push(c); c.query('select pg_sleep(300)').catch(() => {}); } catch (e) { log('postgres_connection_refused', { error: e.message }); break; }
  }
  log('postgres_connections_exhausted', { holders: pgHolders.length }); res.json({ ok: true, holders: pgHolders.length });
});
app.post('/fault/clear-local', async (_req, res) => { await Promise.all(redisHolders.map(c => c.quit().catch(() => c.disconnect()))); await Promise.all(pgHolders.map(c => c.end().catch(() => {}))); redisHolders = []; pgHolders = []; log('local_fault_holders_cleared'); res.json({ ok: true }); });
app.listen(8080, () => log('listening', { port: 8080 }));
