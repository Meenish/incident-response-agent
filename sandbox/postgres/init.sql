-- The checkout API connects as a normal (non-superuser) role. Postgres keeps a few slots
-- reserved for superusers, so when the app role exhausts its slots an operator (or Precedent's
-- remediation, which runs psql as the superuser) can still get in to fix things. Same as production.
CREATE ROLE app LOGIN PASSWORD 'app';
GRANT ALL PRIVILEGES ON DATABASE precedent TO app;
