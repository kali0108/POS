# Database tests (plain Postgres, no Supabase needed)

These run the real migrations + `seed.sql` on a throw-away Postgres 15/16 with tiny stand-ins for Supabase's
`auth` schema and roles, then execute assertion scripts as different users (`set role authenticated` +
`request.jwt.claim.sub`), so Row-Level Security and permission checks are exercised for real.

| Script | Proves |
|---|---|
| `shop_integration.test.sql` | webhook idempotency, branch isolation, accept → fulfil → one invoice, tax split, stock deduction, unmatched-SKU block, cancel-after-invoice flag |
| `zatca_foundation.test.sql` | per-device invoice chain (ICV/PIH), lease so two workers can't fork the chain, counter never burns on failure, signed invoices immutable, private keys unreachable, branch isolation, production invoices undeletable |

```bash
export PGHOST=localhost PGPORT=5432 PGUSER=postgres          # a scratch server you can wipe
psql -c 'drop database if exists postest' -c 'create database postest' && export PGDATABASE=postest
psql -q -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls" || true
psql -q -f supabase/tests/stub_supabase.sql
for f in $(ls supabase/migrations/*.sql | grep -v 0018_hide_owner_from_managers); do psql -q -v ON_ERROR_STOP=1 -f $f; done
psql -q -v ON_ERROR_STOP=1 -f supabase/seed.sql
psql -q -f supabase/tests/shop_integration.test.sql        # prints "... PASSED" or the failing assertion
# re-create the database (steps above) before running the next script:
psql -q -f supabase/tests/zatca_foundation.test.sql
```
Never run these against a real database: they insert test users, branches and invoices.
