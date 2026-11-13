-- =====================================================================
-- 0028_zatca_foundation.sql
-- ZATCA FATOORA Phase 2 — data foundation (Phase 4 of the plan).
-- Nothing here calls ZATCA and nothing changes how a sale is rung up.
--
-- Registration model (per ZATCA's onboarding rules)
--   * ONE taxpayer = ONE VAT number. All branches of the bakery share it.
--     (A branch does NOT need its own VAT number unless it is a separate
--     taxpayer. A VAT group is the one exception: see zatca_taxpayers.)
--   * Every device that issues invoices is its own EGS unit ("solution
--     unit"): own key pair, own CSR, own certificates (CSIDs), own invoice
--     counter (ICV) and previous-invoice-hash chain (PIH).
--   * Private keys are never shared and never leave the zatca_private schema.
-- =====================================================================

insert into permissions (key, label, category) values
  ('zatca.view',    'View ZATCA invoices & status',            'ZATCA'),
  ('zatca.retry',   'Retry failed ZATCA submissions',          'ZATCA'),
  ('zatca.onboard', 'Onboard / renew ZATCA devices',           'ZATCA'),
  ('zatca.manage',  'Manage taxpayer, terminals & tax rules',  'ZATCA')
on conflict (key) do nothing;

insert into role_template_permissions (role_template_id, permission_key, allowed)
select rt.id, p.key, (rt.name = 'Branch Manager' and p.key = 'zatca.view')
from role_templates rt cross join permissions p
where rt.name <> 'Owner' and p.key in ('zatca.view', 'zatca.retry', 'zatca.onboard', 'zatca.manage')
on conflict (role_template_id, permission_key) do nothing;

-- ---------------------------------------------------------------------
-- Taxpayer (the bakery company)
-- ---------------------------------------------------------------------
create table zatca_taxpayers (
  id                 uuid primary key default gen_random_uuid(),
  legal_name         text not null,
  vat_number         text not null unique check (vat_number ~ '^3[0-9]{13}3$'),  -- 15 digits, starts and ends with 3
  crn                text,                                                         -- commercial registration no.
  is_vat_group       boolean not null default false,
  group_member_tin   text check (group_member_tin is null or group_member_tin ~ '^[0-9]{10}$'),
  street             text,
  building_number    text check (building_number is null or building_number ~ '^[0-9]{4}$'),
  plot_identification text,
  district           text,
  city               text,
  postal_code        text check (postal_code is null or postal_code ~ '^[0-9]{5}$'),
  business_category  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (not is_vat_group or group_member_tin is not null)
);

-- Branch details the brief asks for (city, manager, contact) + link to the taxpayer.
alter table branches add column if not exists city        text;
alter table branches add column if not exists email       text;
alter table branches add column if not exists manager_id  uuid references profiles(id) on delete set null;
alter table branches add column if not exists taxpayer_id uuid references zatca_taxpayers(id) on delete set null;
alter table branches add column if not exists crn         text;  -- only if this branch has its own CR number

-- ---------------------------------------------------------------------
-- VAT rules as DATA (never hard-coded): effective-dated, per category.
-- S standard, Z zero-rated, E exempt, O out of scope.
-- ---------------------------------------------------------------------
create table zatca_tax_rules (
  id           uuid primary key default gen_random_uuid(),
  category     text not null check (category in ('S', 'Z', 'E', 'O')),
  rate_percent numeric(5,2) not null check (rate_percent >= 0 and rate_percent <= 100),
  valid_from   date not null,
  valid_to     date,
  label        text,
  unique (category, valid_from),
  check (category = 'S' or rate_percent = 0),
  check (valid_to is null or valid_to >= valid_from)
);
insert into zatca_tax_rules (category, rate_percent, valid_from, valid_to, label) values
  ('S',  5.00, '2018-01-01', '2020-06-30', 'Standard rate (historical)'),
  ('S', 15.00, '2020-07-01', null,         'Standard rate'),
  ('Z',  0.00, '2018-01-01', null,         'Zero-rated'),
  ('E',  0.00, '2018-01-01', null,         'Exempt'),
  ('O',  0.00, '2018-01-01', null,         'Out of scope')
on conflict do nothing;

-- Item VAT treatment (defaults to standard rate, so existing items need no edits).
alter table items add column if not exists vat_category         text not null default 'S' check (vat_category in ('S', 'Z', 'E', 'O'));
alter table items add column if not exists vat_exemption_code   text;
alter table items add column if not exists vat_exemption_reason text;
alter table items add constraint items_vat_reason_chk check (vat_category = 'S' or vat_exemption_code is not null);

-- ---------------------------------------------------------------------
-- POS terminals and ZATCA solution units (EGS)
-- ---------------------------------------------------------------------
create table pos_terminals (
  id                uuid primary key default gen_random_uuid(),
  branch_id         uuid not null references branches(id) on delete restrict,
  name              text not null,
  device_identifier text unique,                 -- asset tag / hardware id
  is_active         boolean not null default true,
  created_at        timestamptz not null default now()
);
create index idx_pos_terminals_branch on pos_terminals(branch_id);

create table zatca_egs_units (
  id                    uuid primary key default gen_random_uuid(),
  taxpayer_id           uuid not null references zatca_taxpayers(id),
  branch_id             uuid not null references branches(id) on delete restrict,
  terminal_id           uuid references pos_terminals(id) on delete restrict,
  environment           text not null check (environment in ('sandbox', 'simulation', 'production')),
  status                text not null default 'draft' check (status in (
                          'draft', 'csr_generated', 'compliance_csid_issued', 'compliance_checks_passed',
                          'production_csid_issued', 'suspended', 'revoked')),
  -- CSR subject: SN = 1-<solution>|2-<model>|3-<uuid v4>, CN = unit name
  egs_serial            text not null unique check (egs_serial ~ '^1-[^|]+\|2-[^|]+\|3-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  common_name           text not null,
  invoice_types         text not null default '1100' check (invoice_types ~ '^[01]{4}$'),  -- 1000 standard, 0100 simplified, 1100 both
  -- Invoice chain. icv = last used counter; last_invoice_hash = PIH for the NEXT invoice.
  -- Initial PIH is base64( hex( SHA-256("0") ) ) as ZATCA specifies for the first invoice.
  icv                   bigint not null default 0,
  -- NB: Postgres' base64 inserts a newline every 76 chars; it must be stripped or the hash is corrupt.
  last_invoice_hash     text not null default replace(encode(convert_to(encode(sha256('0'::bytea), 'hex'), 'UTF8'), 'base64'), E'\n', ''),
  -- Short lease so only ONE worker builds/signs invoices for a unit at a time.
  lease_owner           text,
  lease_until           timestamptz,
  compliance_request_id text,
  onboarded_at          timestamptz,
  certificate_expires_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (terminal_id, environment)
);
create index idx_egs_branch on zatca_egs_units(branch_id);

-- ---------------------------------------------------------------------
-- Secrets: separate schema, invisible to the Data API. Only the backend
-- (service_role) can touch it. Values are AES-GCM ciphertext made by the
-- Edge Function with a key held in Edge Function secrets (ZATCA_KEK), so a
-- database dump alone cannot reveal a private key.
-- ---------------------------------------------------------------------
create schema if not exists zatca_private;
revoke all on schema zatca_private from public, anon, authenticated;
create table zatca_private.egs_credentials (
  egs_unit_id          uuid primary key references public.zatca_egs_units(id) on delete cascade,
  private_key_enc      text not null,
  csr_pem              text,
  compliance_cert_pem  text,
  compliance_secret_enc text,
  production_cert_pem  text,
  production_secret_enc text,
  updated_at           timestamptz not null default now()
);
revoke all on zatca_private.egs_credentials from public, anon, authenticated;
grant usage on schema zatca_private to service_role;
grant all on zatca_private.egs_credentials to service_role;

-- ---------------------------------------------------------------------
-- ZATCA documents (one per POS invoice / credit note) and their history
-- ---------------------------------------------------------------------
create table zatca_invoices (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references invoices(id) on delete cascade,
  refund_id        uuid references refunds(id) on delete cascade,        -- set for credit notes
  egs_unit_id      uuid not null references zatca_egs_units(id),
  doc_uuid         uuid not null unique default gen_random_uuid(),       -- cbc:UUID in the XML
  doc_type         text not null default '388' check (doc_type in ('388', '381', '383')),  -- invoice / credit / debit note
  subtype          text not null check (subtype in ('simplified', 'standard')),
  icv              bigint not null,
  pih              text not null,
  invoice_hash     text not null,
  signed_xml       text not null,
  qr_base64        text,
  status           text not null default 'pending' check (status in ('pending', 'processing', 'reported', 'cleared', 'rejected', 'retry')),
  validation_status text,                                                 -- PASS / WARNING / ERROR from ZATCA
  zatca_response   jsonb,
  cleared_xml      text,                                                  -- standard invoices: ZATCA-stamped XML
  attempts         int not null default 0,
  last_error       text,
  next_attempt_at  timestamptz not null default now(),
  issued_at        timestamptz not null default now(),
  submitted_at     timestamptz,
  unique (egs_unit_id, icv),                                              -- the chain can never fork or repeat
  check ((doc_type = '388') = (refund_id is null))
);
create unique index uq_zatca_one_invoice_per_sale on zatca_invoices(invoice_id) where doc_type = '388';
create unique index uq_zatca_one_note_per_refund  on zatca_invoices(refund_id)  where refund_id is not null;
create index idx_zatca_invoices_queue on zatca_invoices(status, next_attempt_at) where status in ('pending', 'retry');

create table zatca_submissions (
  id               bigint generated always as identity primary key,
  zatca_invoice_id uuid not null references zatca_invoices(id) on delete cascade,
  attempt_no       int not null,
  endpoint         text not null,           -- 'reporting' | 'clearance' | 'compliance'
  http_status      int,
  outcome          text,                    -- reported / cleared / rejected / network_error
  response         jsonb,
  created_at       timestamptz not null default now()
);
create index idx_zatca_submissions_doc on zatca_submissions(zatca_invoice_id, attempt_no);

-- ---------------------------------------------------------------------
-- Guards (the "never lose or alter a tax record" rules)
-- ---------------------------------------------------------------------
-- 1. Once an invoice is stamped into the chain, its identity and signed content are frozen.
create or replace function zatca_freeze_issued()
returns trigger language plpgsql as $$
begin
  if new.doc_uuid is distinct from old.doc_uuid or new.icv is distinct from old.icv
     or new.pih is distinct from old.pih or new.invoice_hash is distinct from old.invoice_hash
     or new.signed_xml is distinct from old.signed_xml or new.invoice_id is distinct from old.invoice_id
     or new.egs_unit_id is distinct from old.egs_unit_id or new.doc_type is distinct from old.doc_type then
    raise exception 'An issued ZATCA invoice cannot be changed (counter %, uuid %). Issue a credit note instead.', old.icv, old.doc_uuid;
  end if;
  return new;
end $$;
create trigger trg_zatca_freeze_issued before update on zatca_invoices
  for each row execute function zatca_freeze_issued();

-- 2. A PRODUCTION ZATCA invoice can never be deleted (6-year record keeping), whether directly,
--    by deleting the POS bill, or by "reset all business data". Sandbox/simulation data may be wiped.
create or replace function zatca_protect_production_invoices()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'invoices' then
    if exists (select 1 from zatca_invoices z join zatca_egs_units e on e.id = z.egs_unit_id
                where z.invoice_id = old.id and e.environment = 'production') then
      raise exception 'Invoice % was issued to ZATCA (production) and must be kept. Use a refund / credit note instead of deleting it.', old.invoice_number;
    end if;
  else
    if exists (select 1 from zatca_egs_units e where e.id = old.egs_unit_id and e.environment = 'production') then
      raise exception 'Production ZATCA invoices cannot be deleted.';
    end if;
  end if;
  return old;
end $$;
create trigger trg_zatca_protect_invoices before delete on invoices
  for each row execute function zatca_protect_production_invoices();
create trigger trg_zatca_protect_docs before delete on zatca_invoices
  for each row execute function zatca_protect_production_invoices();

-- 3. Terminals/branches that own a production unit can't be removed (FKs are RESTRICT) —
--    and a production unit itself can't be deleted.
create or replace function zatca_protect_production_units()
returns trigger language plpgsql as $$
begin
  if old.environment = 'production' then
    raise exception 'A production ZATCA unit cannot be deleted. Suspend or revoke it instead.';
  end if;
  return old;
end $$;
create trigger trg_zatca_protect_units before delete on zatca_egs_units
  for each row execute function zatca_protect_production_units();

-- ---------------------------------------------------------------------
-- The invoice chain: claim -> build & sign (outside the DB) -> commit.
-- The counter and the previous-hash move ONLY inside zatca_commit_invoice,
-- in the same transaction that stores the invoice, so a crash mid-way can
-- never burn a counter or skip a hash. The lease keeps two workers from
-- building on the same "previous hash" at once.
-- Backend only (service_role).
-- ---------------------------------------------------------------------
create or replace function zatca_claim_unit(p_egs uuid, p_owner text, p_ttl_seconds int default 120)
returns table (claimed boolean, next_icv bigint, pih text)
language plpgsql security definer set search_path = public as $$
declare u zatca_egs_units%rowtype;
begin
  select * into u from zatca_egs_units where id = p_egs for update;
  if not found then raise exception 'Unknown EGS unit'; end if;
  if u.status <> 'production_csid_issued' and u.environment = 'production' then
    raise exception 'Unit is not active for production (status: %)', u.status;
  end if;
  if u.lease_until is not null and u.lease_until > now() and u.lease_owner is distinct from p_owner then
    return query select false, null::bigint, null::text; return;
  end if;
  update zatca_egs_units set lease_owner = p_owner, lease_until = now() + make_interval(secs => p_ttl_seconds) where id = p_egs;
  return query select true, u.icv + 1, u.last_invoice_hash;
end $$;

create or replace function zatca_release_unit(p_egs uuid, p_owner text)
returns void language sql security definer set search_path = public as $$
  update zatca_egs_units set lease_owner = null, lease_until = null where id = p_egs and lease_owner = p_owner;
$$;

create or replace function zatca_commit_invoice(
  p_egs uuid, p_owner text, p_invoice_id uuid, p_refund_id uuid, p_doc_uuid uuid, p_doc_type text,
  p_subtype text, p_icv bigint, p_invoice_hash text, p_signed_xml text, p_qr text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare u zatca_egs_units%rowtype; v_id uuid;
begin
  select * into u from zatca_egs_units where id = p_egs for update;
  if not found then raise exception 'Unknown EGS unit'; end if;
  if u.lease_owner is distinct from p_owner or u.lease_until is null or u.lease_until < now() then
    raise exception 'Lease on this unit was lost; rebuild the invoice.';
  end if;
  if p_icv <> u.icv + 1 then
    raise exception 'Counter mismatch: expected %, got %.', u.icv + 1, p_icv;
  end if;

  insert into zatca_invoices (invoice_id, refund_id, egs_unit_id, doc_uuid, doc_type, subtype, icv, pih, invoice_hash, signed_xml, qr_base64)
  values (p_invoice_id, p_refund_id, p_egs, p_doc_uuid, p_doc_type, p_subtype, p_icv, u.last_invoice_hash, p_invoice_hash, p_signed_xml, p_qr)
  returning id into v_id;

  update zatca_egs_units set icv = p_icv, last_invoice_hash = p_invoice_hash, updated_at = now() where id = p_egs;
  return v_id;
end $$;

revoke all on function zatca_claim_unit(uuid, text, int) from public, anon, authenticated;
revoke all on function zatca_release_unit(uuid, text) from public, anon, authenticated;
revoke all on function zatca_commit_invoice(uuid, text, uuid, uuid, uuid, text, text, bigint, text, text, text) from public, anon, authenticated;
grant execute on function zatca_claim_unit(uuid, text, int) to service_role;
grant execute on function zatca_release_unit(uuid, text) to service_role;
grant execute on function zatca_commit_invoice(uuid, text, uuid, uuid, uuid, text, text, bigint, text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- Staff-facing: create a solution unit for a terminal (no crypto here;
-- the CSR/keys are made by the backend during onboarding).
-- ---------------------------------------------------------------------
create or replace function zatca_create_egs_unit(p_terminal_id uuid, p_environment text, p_invoice_types text default '1100')
returns uuid
language plpgsql security definer set search_path = public as $$
declare t pos_terminals%rowtype; b branches%rowtype; v_id uuid; v_serial text;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if not has_permission('zatca.onboard') then raise exception 'Missing permission: zatca.onboard'; end if;
  select * into t from pos_terminals where id = p_terminal_id;
  if not found then raise exception 'Terminal not found.'; end if;
  if not has_branch_access(t.branch_id) then raise exception 'No access to this branch.'; end if;
  select * into b from branches where id = t.branch_id;
  if b.taxpayer_id is null then raise exception 'Link the branch to the taxpayer (VAT registration) first.'; end if;

  v_serial := '1-BakeryPOS|2-1.0|3-' || gen_random_uuid()::text;
  insert into zatca_egs_units (taxpayer_id, branch_id, terminal_id, environment, egs_serial, common_name, invoice_types)
  values (b.taxpayer_id, t.branch_id, t.id, p_environment, v_serial, b.code || '-' || t.name, p_invoice_types)
  returning id into v_id;

  perform log_activity('zatca.unit.create', t.branch_id, 'zatca_egs_unit', v_id::text,
                       jsonb_build_object('environment', p_environment, 'terminal', t.name));
  return v_id;
end $$;
grant execute on function zatca_create_egs_unit(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- RLS + grants (read-only from the browser; writes go through functions)
-- ---------------------------------------------------------------------
alter table zatca_taxpayers   enable row level security;
alter table zatca_tax_rules   enable row level security;
alter table pos_terminals     enable row level security;
alter table zatca_egs_units   enable row level security;
alter table zatca_invoices    enable row level security;
alter table zatca_submissions enable row level security;

create policy zatca_taxpayers_read on zatca_taxpayers for select to authenticated using (has_permission('zatca.view') or has_permission('zatca.manage'));
create policy zatca_taxpayers_write on zatca_taxpayers for all to authenticated using (has_permission('zatca.manage')) with check (has_permission('zatca.manage'));
create policy zatca_tax_rules_read on zatca_tax_rules for select to authenticated using (true);
create policy zatca_tax_rules_write on zatca_tax_rules for all to authenticated using (has_permission('zatca.manage')) with check (has_permission('zatca.manage'));

create policy pos_terminals_read on pos_terminals for select to authenticated
  using ((has_permission('zatca.view') or has_permission('zatca.manage')) and has_branch_access(branch_id));
create policy pos_terminals_write on pos_terminals for all to authenticated
  using (has_permission('zatca.manage') and has_branch_access(branch_id))
  with check (has_permission('zatca.manage') and has_branch_access(branch_id));

create policy zatca_egs_read on zatca_egs_units for select to authenticated
  using (has_permission('zatca.view') and has_branch_access(branch_id));
create policy zatca_invoices_read on zatca_invoices for select to authenticated
  using (has_permission('zatca.view') and exists (select 1 from zatca_egs_units e where e.id = egs_unit_id));
create policy zatca_submissions_read on zatca_submissions for select to authenticated
  using (exists (select 1 from zatca_invoices z where z.id = zatca_invoice_id));

grant select, insert, update, delete on zatca_taxpayers, zatca_tax_rules, pos_terminals to authenticated;
grant select on zatca_egs_units, zatca_invoices, zatca_submissions to authenticated;

-- Backend workers (Edge Functions, service_role) need full access; see the note in 0027 / 0009.
grant select, insert, update, delete on zatca_taxpayers, zatca_tax_rules, pos_terminals, zatca_egs_units,
  zatca_invoices, zatca_submissions to service_role;
grant select on invoices, invoice_items, payments, refunds, items, branches to service_role;
grant usage on all sequences in schema public to service_role;
