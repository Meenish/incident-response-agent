# Precedent

**An on-call incident agent that remembers every failure your team has fixed.**

Precedent watches a real (small) production-like system running in Docker. When a dependency fails, it opens an incident, recalls similar past incidents from [Hindsight](https://hindsight.vectorize.io/) memory, and recommends the fix that worked before. When you apply a fix, it runs the real command, measures whether the system actually recovered, and only then saves the post-mortem. The next similar incident gets a better first suggestion.

A memory-less agent runs beside it on every alert, so you can see the difference memory makes.

Built for the *AI Agents That Learn Using Hindsight* hackathon (Engineering and DevOps: **Incident Response Agent**).

---

## Contents

1. [The idea in one minute](#1-the-idea-in-one-minute)
2. [Architecture](#2-architecture)
3. [Requirements and setup](#3-requirements-and-setup)
4. [Running it](#4-running-it)
5. [The demo, step by step](#5-the-demo-step-by-step)
6. [Every button, explained](#6-every-button-explained)
7. [How an alert appears](#7-how-an-alert-appears)
8. [The two agents](#8-the-two-agents)
9. [What Apply does](#9-what-apply-does)
10. [How Hindsight memory is used](#10-how-hindsight-memory-is-used)
11. [The right-hand panel](#11-the-right-hand-panel)
12. [The lab and its faults](#12-the-lab-and-its-faults)
13. [Project layout](#13-project-layout)
14. [Configuration](#14-configuration)
15. [Troubleshooting](#15-troubleshooting)
16. [Known limitations](#16-known-limitations)

---

## 1. The idea in one minute

When a service fails at 2 a.m., the engineer on call usually starts from scratch: restart something, read logs, guess. Someone on the team has often fixed the same failure before, but that knowledge is buried in chat threads or in one person's head.

Precedent turns that history into memory:

1. **Watch.** A health check probes a real checkout API that depends on Redis and Postgres.
2. **Detect.** When a dependency fails, Precedent opens an incident with the relevant log lines.
3. **Recall.** It searches Hindsight for similar past incidents and what fixed them.
4. **Recommend.** It ranks fixes, putting the one that worked before first, and explains why. A generic, memory-less checklist is shown next to it.
5. **Act.** Clicking **Apply** runs a real Docker command.
6. **Measure.** It samples the live health check to see whether the fix truly worked.
7. **Learn.** Success or failure is written to memory, so the next similar alert starts smarter.

Nothing is scripted: there is no pre-written alert queue and no success flag. Alerts come from a failing health check, and "worked" means the health check passed afterwards.

---

## 2. Architecture

```
 Browser (localhost:3000)
        |  polls /api/state every 3 s, sends button clicks
        v
 Precedent server (Node + Express, server.js)
   |-- lib/lab.js      runs `docker compose ...` commands and calls the checkout API
   |-- lib/agent.js    baseline brief, memory brief, rules engine, pattern stats
   |-- lib/memory.js   Hindsight client (retain / recall / reflect) + local BM25 fallback
   |-- lib/llm.js      Groq LLM client with retries and model fallback
   |-- data/state.json incidents, history, stats, activity log
        |
        |------------------------------> Hindsight Cloud (memory bank)
        |------------------------------> Groq API (writes the triage narrative)
        v
 Docker lab (docker-compose.yml)
   |-- checkout   Node API on :8080  (/health, /fault/*)   <-- what Precedent watches
   |-- redis      Redis 7, maxclients 1000
   |-- postgres   Postgres 16, max_connections 30, 3 reserved for superusers
```

| Part | Role |
|---|---|
| **Browser page** | The dashboard. Refreshes itself every 3 seconds and redraws only when something changed. |
| **Precedent server** | Detects incidents, runs both agents, applies fixes, measures recovery, stores state. |
| **Checkout API** | The "production service". Its `/health` opens a real connection to Redis and Postgres. Also hosts the fault injectors. |
| **Redis / Postgres** | Real databases that you can break on purpose. |
| **Hindsight** | Long-term memory. Post-mortems are retained here and recalled later. |
| **Groq** (optional) | Writes the memory agent's explanation, using only the recalled memories as evidence. |

---

## 3. Requirements and setup

- **Docker Desktop**, installed and running (the engine must say "Engine running").
- **Node.js 18 or newer** and npm.
- **Internet access**, for Docker Hub (first build), Hindsight, and Groq. DNS must work.
- Optional keys: a **Hindsight** key and a **Groq** key. Without them the app still works in offline mode (local memory and a rules engine).

Create a `.env` file in the project folder (copy `.env.example`):

```
HINDSIGHT_BASE_URL=https://api.hindsight.vectorize.io
HINDSIGHT_API_KEY=your-hindsight-key
HINDSIGHT_BANK=precedent-oncall
GROQ_API_KEY=your-groq-key
GROQ_MODEL=openai/gpt-oss-120b
PORT=3000
```

Leave `HINDSIGHT_BASE_URL` blank to run fully offline. **Never commit or share `.env`.**

Install dependencies once:

```
npm install
```

---

## 4. Running it

All commands are for **Windows PowerShell** from the project folder (`cd E:\vinay_leadder\claud2\precedent`).

**Daily start** (keeps memory and history):

```powershell
docker compose up -d
curl.exe -m 10 http://127.0.0.1:8080/health     # must print {"ok":true}
npm start
```

Then open <http://localhost:3000> and press `Ctrl+F5`.

**Clean start** (fresh lab, wipes saved state, use before a demo or recording):

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
docker compose down -v --remove-orphans
Remove-Item data\state.json -ErrorAction SilentlyContinue
docker compose up -d --build
Start-Sleep -Seconds 12
curl.exe -m 10 http://127.0.0.1:8080/health
npm start
```

If a `start-clean.ps1` file is present in the project folder, the same clean start is one command:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-clean.ps1
```

`down -v` matters: the non-superuser Postgres role is only created on a fresh database.

**Stop:**

```powershell
# app: Ctrl+C in its terminal, or
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
docker compose stop            # stop the lab (or: docker compose down -v --remove-orphans)
```

**npm scripts:**

| Command | What it does |
|---|---|
| `npm start` | Starts the Precedent server on port 3000. |
| `npm run lab:up` | `docker compose up -d --build`. |
| `npm run lab:bootstrap` | With the server running, performs three real break/fix cycles (Redis, Postgres, Redis) and saves the real post-mortems, so memory is pre-populated. |
| `npm run demo` | With the server running, walks through Redis and Postgres faults using the memory agent's top suggestion each time. |

---

## 5. The demo, step by step

1. Open <http://localhost:3000>, press `Ctrl+F5`, click **Reset** and confirm. The page says "Waiting for a live alert".
2. Click **Break Redis**. A green message confirms the fault. Within about 5 seconds an alert appears on the left.
3. Click **Ask both agents**. Both columns fill in. On a first-ever incident they look alike, because memory is empty ("no precedent").
4. In the **With memory** column, click **Apply** on the top suggestion. Wait about 10 seconds. The alert turns green and shows how long it took.
5. Click **Exhaust Postgres** and repeat steps 2 to 4.
6. Click **Break Redis** again and ask both agents. This time the memory column recalls your first Redis incident, cites its ID, and puts the fix that worked first. The baseline column still starts with "restart the service".

That last step is the point of the project: same failure, better answer, because the agent remembered.

You can break both systems at once. Each fix is judged only by the dependency it targets, so fixing Redis is not marked "failed" just because Postgres is still down. For the cleanest demo, still do one at a time.

---

## 6. Every button, explained

### Left column

| Button | What happens |
|---|---|
| **Run the full demo** | Automates the cycle for every open alert: ask both agents, apply the memory agent's top suggestion, and if it did not work, re-ask (now excluding the failed fix) and try the next one, up to 6 tries per alert. It needs at least one open alert; otherwise it tells you to break something first. While running, the button reads **Stop demo**, which halts after the current step. |
| **Reset** | After a confirmation, wipes all app state (incidents, history, stats, activity log) and creates a **new, empty Hindsight memory bank**. It does not touch Docker or any fault still active. Old banks stay in your Hindsight account, unused. |
| **Start Docker lab** | Runs `docker compose up -d --build`, then waits up to 60 more seconds for `/health` to turn green. The first run builds images and can take a few minutes. A message tells you it is working, then confirms when the lab is healthy. |
| **Break Redis** | Asks the checkout API to lower Redis `maxclients` to 8 and hold connections until every slot is taken. `/health` then fails on Redis. |
| **Exhaust Postgres** | Asks the checkout API to open connections, each running `pg_sleep(300)`, until all normal Postgres slots are taken. `/health` then fails on Postgres. |
| **Alert list** | Clicking an alert selects it so you can inspect it. Each row shows severity, service, and status: "Open", "N tried" (fixes attempted), or a green check with minutes to resolve. |

### Centre pane

| Control | What happens |
|---|---|
| **Ask both agents** / **Re-run triage** | Runs both agents on the selected alert (see [section 8](#8-the-two-agents)). After a failed fix it runs automatically so the ranking updates. |
| **Apply** (memory column) | Runs the real fix and measures recovery (see [section 9](#9-what-apply-does)). |
| **Raw memories returned by Hindsight** | Expands to show the exact memory text Hindsight returned for this alert, so you can check the agent's evidence. |
| **Yellow ID chips** | Incident IDs the recommendation cites, for example `LAB-redis-maxclients-abc123`. |

### Right column

| Control | What happens |
|---|---|
| **Ask Hindsight to reflect** | Asks Hindsight to summarize recurring failures and successful remediations across everything in the bank. The text appears below the button. In offline mode it explains that reflection needs Hindsight. |

### Top bar

Two chips show the memory backend ("Hindsight memory" or "Local memory (offline mode)") and the model in use ("openai/gpt-oss-120b" or "Rules engine (no LLM key)"). Green means connected.

### Messages

Every action shows a message at the top of the page: blue while working, green on success, red on error. Errors also stay in a banner inside the alert.

---

## 7. How an alert appears

The server calls the checkout API's `/health` (at most once every 2.5 seconds; the page asks for fresh state every 3 seconds).

- **Healthy:** no alert. If a generic "lab unreachable" or "dependency unhealthy" alert was open, it closes.
- **Failing:** the response names which dependency failed. Precedent opens **one incident per failed dependency**, attaching the last few checkout log lines that mention that dependency:

| Failed dependency | Incident |
|---|---|
| Redis | `checkout-api is failing fresh Redis connections` (SEV2) |
| Postgres | `checkout-api is being refused by Postgres` (SEV2) |
| Something else | `checkout-api dependency health check is failing` (SEV3) |
| Lab unreachable | `Docker lab is not reachable` (SEV3), for example when Docker is stopped |

An incident ID looks like `LAB-redis-maxclients-mummcy5o`. If an incident of the same kind is already open, its logs are refreshed instead of opening a duplicate.

Alerts come **only** from the failing health check. That is why the page shows "Waiting for a live alert" when everything is healthy.

---

## 8. The two agents

Both run on every **Ask both agents** click, on the same alert.

### Without memory (baseline)

A fixed checklist. It always suggests **restart the checkout service** first, then the fix for the affected dependency. Confidence (20%) and estimated time (45 minutes) are hardcoded. It never improves.

### With memory

1. **Recall.** It asks Hindsight for memories similar to the alert (service, title, and log lines), keeping the top 6.
2. **Find precedents.** It extracts incident IDs from those memories. An ID only counts if it also exists in the local incident ledger.
3. **No precedent?** If nothing similar is found, the column says "memory (no precedent)", falls back to the generic checklist, and shows low confidence (15%). This is what you see on the first incident after **Reset**.
4. **With precedents**, it builds a recommendation:
   - **LLM path (if a Groq key is set).** The alert and recalled memories go to Groq (`openai/gpt-oss-120b`, falling back to `qwen/qwen3-32b`, two attempts each, 25-second timeout). The model returns JSON: summary, probable cause, confidence, ranked fixes, and fixes to avoid. The server validates the answer: only known fix names are kept, only real recalled incident IDs may be cited, and fixes already tried on this alert are removed.
   - **Rules path (fallback, or no key).** Each fix earns a score from past incidents: positive if it worked, negative if it failed, weighted by how highly that memory ranked. Confidence and time estimate come from those results.
5. **Output.** Recalled incidents, ranked next steps (each citing its evidence), and a "skip these, they failed before" list.

The columns show side by side: summary, confidence ring, estimated time, probable cause, recalled incidents (memory column only), and the action list.

---

## 9. What Apply does

Clicking **Apply** on a suggestion:

**1. Runs the real fix.** Only these three allow-listed commands exist:

| Fix | Command |
|---|---|
| **Restart checkout service** | `docker compose restart checkout` |
| **Raise Redis maxclients / pool size** | Releases the fault's Redis connections, then runs `redis-cli CONFIG SET maxclients 1000` inside the Redis container. |
| **Terminate long-running queries** | Runs `pg_terminate_backend(...)` on the sleeping sessions inside the Postgres container as the superuser (retrying a few times), then releases the fault connections. |

**2. Measures recovery.** It samples `/health` up to 8 times, about 1.25 seconds apart. The fix counts as successful when the dependency that incident is about stops failing, or the whole health check passes.

**3a. If it worked:** the alert turns green and shows the minutes it took. A post-mortem (incident, service, logs, root cause, the fix that worked, minutes, any failed attempts) is saved to the local ledger and retained in Hindsight. The stats record whether each agent's **first** suggestion turned out to be the right fix.

**3b. If it did not work:** the attempt is recorded as failed and retained in Hindsight as "did NOT restore the live health check". The alert shows "N tried", and triage re-runs so the memory agent re-ranks without that fix. Failed attempts are also included in the post-mortem once the alert is eventually resolved.

---

## 10. How Hindsight memory is used

Memory is the centre of the project, not an add-on. Hindsight is used for three operations:

| Operation | When | What |
|---|---|---|
| **Retain** | After every measured outcome | Successful post-mortems ("fix that worked, resolved in N min, attempted but did NOT work: ...") and failed remediation outcomes are stored as text with incident IDs attached. |
| **Recall** | Every time you ask both agents | The alert's service, title, and logs are the query. The returned memories are the only evidence the memory agent may use, and they are shown verbatim under **Raw memories**. |
| **Reflect** | **Ask Hindsight to reflect** | Hindsight synthesizes recurring failures and working remediations across the whole bank. |

Details:

- On first start (and after **Reset**) the app creates a Hindsight **bank** with a unique name (`precedent-oncall-<timestamp>`) and a mission that tells Hindsight to track symptoms, root cause, which fixes worked and did not, timing, and patterns, always keeping incident IDs attached.
- Memory is written **only after the outcome is measured** against the live system. Nothing is fabricated or pre-loaded.
- Without Hindsight configured, a **local BM25 keyword store** with the same interface is used, so the app still runs offline. Hindsight is the real memory layer.
- The visible before and after: the baseline column never changes; the memory column goes from "no precedent, generic checklist" to "recalled these incidents, this fix worked before, skip that one".

---

## 11. The right-hand panel

| Section | Meaning |
|---|---|
| **Is the first suggestion right?** | After each resolved alert, the running share of alerts where each agent's *first* suggestion was the fix that worked. Two lines: with memory and without. |
| **Time to fix** | Minutes per resolved alert, compared with a fixed 45-minute generic-checklist figure, plus the average. |
| **What the team now knows** | Fixes that worked at least twice on the same service, and a worked/failed count for every fix. |
| **Ask Hindsight to reflect** | See [section 6](#6-every-button-explained). |
| **Memory activity** | A live log of what happened: `alert`, `recall`, `retain`, `lab`, and `reflect` events. |

---

## 12. The lab and its faults

`docker compose up` starts three containers, all reachable only from your own machine:

| Container | Port | Notes |
|---|---|---|
| `checkout` | 8080 | Node API. `/health` probes Redis and Postgres (3-second cap each). `/fault/*` endpoints inject and clear faults. |
| `redis` | 6379 | Started with `maxclients 1000`. |
| `postgres` | 5432 | `max_connections=30`, `superuser_reserved_connections=3`. The checkout API connects as a normal role (`app`), so admin slots stay free for the fix, as in production. The role is created by `sandbox/postgres/init.sql` on a fresh database. |

**Redis fault** (`POST /fault/redis-exhaust`): lowers `maxclients` to 8 and holds real client connections until every slot is taken. New connections are refused, so `/health` fails on Redis.

**Postgres fault** (`POST /fault/postgres-exhaust`): opens connections as the app role, each running `pg_sleep(300)`, until the 27 normal slots are gone. The 3 reserved slots remain for superusers, which is why the error reads *remaining connection slots are reserved for roles with the SUPERUSER attribute* and why the fix (running as the superuser) can still get in.

**Clear** (`POST /fault/clear-local`): releases the fault connections held by the checkout process.

You can call the fault endpoints yourself (they accept **POST only**; a browser gives "Cannot GET"):

```powershell
curl.exe -m 15 -X POST http://127.0.0.1:8080/fault/redis-exhaust
curl.exe -m 10 http://127.0.0.1:8080/health
curl.exe -X POST http://127.0.0.1:8080/fault/clear-local
```

---

## 13. Project layout

```
precedent/
  server.js                 Express server: state, detection, triage, apply, reset, reflect
  lib/
    lab.js                  Docker/lab adapter and the allow-listed fixes
    agent.js                Baseline brief, memory brief (LLM + rules), pattern stats
    catalog.js              Fix catalog and the generic playbook
    memory.js               HindsightMemory and LocalMemory (BM25 fallback)
    llm.js                  Groq client: retries, model fallback, tolerant JSON parsing
  public/index.html         The dashboard (single file: HTML, CSS, JS)
  sandbox/
    checkout/               The demo service and fault injectors (Dockerfile, index.js)
    postgres/init.sql       Creates the non-superuser app role
  scripts/
    bootstrap.mjs           Three real break/fix cycles to pre-populate memory
    demo.mjs                Live walkthrough using the memory agent's top suggestion
  docker-compose.yml        Redis, Postgres, checkout
  data/state.json           Saved app state (created at runtime, git-ignored)
  .env / .env.example       Configuration and keys
```

---

## 14. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HINDSIGHT_BASE_URL` | blank | Hindsight endpoint. **Blank means offline mode.** |
| `HINDSIGHT_API_KEY` | blank | Hindsight key (not needed for a self-hosted instance). |
| `HINDSIGHT_BANK` | `precedent-oncall` | Bank name prefix; a timestamp suffix is added. |
| `GROQ_API_KEY` | blank | Enables LLM-written triage. Blank uses the rules engine. |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Primary model. `qwen/qwen3-32b` is the fallback. |
| `PORT` | `3000` | Port for the Precedent server. |

Modes:

| Hindsight | Groq | Result |
|---|---|---|
| set | set | Full experience: Hindsight memory and LLM narrative. |
| set | blank | Hindsight memory with the rules engine. |
| blank | any | Offline: local BM25 memory. Docker observation, fixes, and measurement are still real. |

---

## 15. Troubleshooting

**No alert appears after Break Redis.** Wait a few seconds; the page refreshes every 3 seconds. Check the fault took hold:

```powershell
curl.exe -m 10 http://127.0.0.1:8080/health
```

A 503 naming `redis` means it is live. `{"ok":true}` means the fault did not take.

**"Docker lab is not reachable" / `failed to connect to the docker API`.** Docker Desktop is not running. Start it and wait for "Engine running":

```powershell
Start-Process "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
do { Start-Sleep -Seconds 5; docker info *> $null } until ($LASTEXITCODE -eq 0); "Docker is ready"
```

**`no such host` / `failed to fetch oauth token` during build.** DNS problem. In an **Administrator** PowerShell:

```powershell
Set-DnsClientServerAddress -InterfaceAlias "Wi-Fi" -ServerAddresses ("8.8.8.8","1.1.1.1")
ipconfig /flushdns
nslookup auth.docker.io
```

Then restart Docker Desktop (`wsl --shutdown`, start it again). Still failing: try a phone hotspot.

**Health check hangs or the fault call times out.** The container may be running old code. Rebuild:

```powershell
docker compose up -d --build --force-recreate checkout
```

**A fault is stuck** (`ERR max number of clients reached`, `too many clients`). Release the fault clients first, then raise the limit. Stop as soon as health is `{"ok":true}`:

```powershell
curl.exe -X POST http://127.0.0.1:8080/fault/clear-local
docker compose exec -T redis redis-cli CONFIG SET maxclients 1000
docker compose restart postgres
docker compose restart checkout
```

**Postgres sessions linger after a restart.** They run `pg_sleep(300)` and can survive up to 5 minutes. Terminate them or restart Postgres:

```powershell
docker compose exec -T postgres psql -U precedent -d precedent -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep%' AND pid <> pg_backend_pid();"
```

**Check the patched code is running:**

```powershell
docker compose exec -T checkout grep -c reconnectStrategy index.js
docker compose exec -T postgres psql -U precedent -d precedent -c "\du"
```

The first must print 1 or more; the second must list a role named `app`.

**Logs:**

```powershell
docker compose logs --tail 50 checkout
```

**Hindsight error banner.** Check `HINDSIGHT_BASE_URL` and `HINDSIGHT_API_KEY` in `.env`, then restart the app.

---

## 16. Known limitations

These are properties of the demo lab, listed so nothing surprises you:

- **Some fixes clear both faults.** The Redis and Postgres fixes both release every fault connection the checkout process holds. A "wrong" fix can therefore incidentally clear the other fault, which can make results look odd.
- **"Restart checkout service" can report "Did not work".** A restart takes several seconds, close to the roughly 10-second measurement window, so the check can end before the service is back. The failure is then saved to memory.
- **Time to fix includes your idle time.** It measures from when the alert opened to when the fix worked, not the fix alone. The 45-minute baseline is a fixed assumption, not a measurement.
- **Log lines are filtered, not perfect.** Precedent shows the recent checkout log lines that mention the failing dependency; older lines can appear.
- **Reset leaves old Hindsight banks** in your account; the app just stops using them.
- **Local use only.** The server runs Docker commands without authentication and is meant for your own machine. Do not expose it to a network.
- **Keys.** `.env` holds live API keys. Do not commit or share it, and rotate the keys if it was ever shared.
