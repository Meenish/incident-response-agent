# Precedent: an on-call agent that learns from real incidents

Precedent now runs against a self-contained Docker lab rather than a prepared alert list. The lab contains a real Redis, a real Postgres, and a small Node checkout API. Alerts appear only when the checkout API's dependency health probe fails; the displayed evidence comes from the checkout container's stdout logs.

Two fault paths are provided:

- Redis client exhaustion: the checkout process lowers Redis `maxclients` and holds real TCP client connections. The recovery command is `redis-cli CONFIG SET maxclients 1000`, followed by releasing the fault clients.
- Postgres connection exhaustion: the checkout process opens real `pg_sleep` sessions until normal connection slots are unavailable. The recovery command is `pg_terminate_backend(...)` executed inside the Postgres container.

There is no `truth.fix`, pre-written alert queue, or success flag. When an operator applies a recommendation, the server runs the corresponding Docker command and samples `GET /health` eight times. Only a passing health sample marks the remediation as worked and retains its post-mortem in Hindsight (or the offline BM25 store).

## Run

Docker Desktop must be installed and running.

```bash
npm install
npm start
# in a second terminal
npm run lab:up
```

Open http://localhost:3000. Use **Break Redis** or **Exhaust Postgres** to inject a real fault, then triage it. **Start Docker lab** is also available in the interface.

For a pre-populated, still-genuine memory bank, leave the server running and execute:

```bash
npm run lab:bootstrap
```

That script performs three real break/fix cycles, waits for measured recovery each time, and writes the resulting post-mortems to the configured memory backend. It intentionally does not manufacture historical records.

## Memory and reasoning

Set `HINDSIGHT_BASE_URL` and `HINDSIGHT_API_KEY` in `.env` to retain/recall/reflect through Hindsight. Set `GROQ_API_KEY` to have Groq write the evidence-bound triage narrative. Without keys, the application runs with the local BM25 fallback and rules-based triage; the Docker observation, remediation, and outcome measurement remain real either way.

The executable lab adapter is in `lib/lab.js`; its allowlisted commands are the only remediations the application can run. The service implementation and fault injectors are in `sandbox/checkout/`.
