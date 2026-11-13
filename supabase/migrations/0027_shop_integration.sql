-- =====================================================================
-- 0027_shop_integration.sql
-- Links the Foodies online shop (Next.js storefront) to this POS.
--
-- Contract with the storefront (see its README, "Linking with your POS"):
--   * Products are matched by SKU  (items.sku is already unique here).
--   * POS -> website : price + stock pushed by the `shop-sync` function.
--   * Website -> POS : signed webhook `shop-webhook` (HMAC-SHA256),
--                      with a pull fallback in `shop-sync`.
--
-- Design rules:
--   1. Website orders land in an INBOX (online_orders). Nothing touches
--      invoices or stock until staff fulfil the order.
--   2. Fulfilling goes through the existing sync_invoice(), so numbering,
--      stock deduction, audit log and (later) ZATCA all stay on ONE path.
--   3. The webhook is idempotent on the shop's order id (external_ref):
--      the shop retries and re-sends on payment confirmation.
--   4. Online prices are final consumer prices and INCLUDE tax. Tax is
--      backed out of what the customer was actually charged, so the
--      invoice total always equals the money received.
-- =====================================================================

insert into permissions (key, label, category) values
  ('online_orders.view',   'View online shop orders',                 'Online shop'),
  ('online_orders.manage', 'Accept / fulfil orders, sync the website', 'Online shop')
on conflict (key) do nothing;
-- Role defaults live in seed.sql (see the note in 0012).

-- Existing deployments already ran seed.sql, so back-fill the role matrix here
-- (a fresh deployment has no role_templates yet; seed.sql covers that case).
-- Branch Manager gets both; every other non-Owner template gets an explicit "no".
insert into role_template_permissions (role_template_id, permission_key, allowed)
select rt.id, p.key, (rt.name = 'Branch Manager')
from role_templates rt
cross join permissions p
where rt.name <> 'Owner' and p.key in ('online_orders.view', 'online_orders.manage')
on conflict (role_template_id, permission_key) do nothing;

-- ---------------------------------------------------------------------
-- Single-row settings
-- ---------------------------------------------------------------------
create table shop_settings (
  id                       boolean primary key default true check (id),
  default_branch_id        uuid references branches(id) on delete set null,
  -- true: the price pushed to the website = POS unit_price * (1 + branch tax rate)
  -- false: push the POS unit_price unchanged (use if POS prices already include tax)
  push_gross_prices        boolean not null default true,
  last_catalog_push_at     timestamptz,
  last_catalog_push_result jsonb,
  last_order_pull_at       timestamptz,
  updated_at               timestamptz not null default now()
);
insert into shop_settings default values on conflict do nothing;

-- ---------------------------------------------------------------------
-- Inbox
-- ---------------------------------------------------------------------
create table online_orders (
  id               uuid primary key default gen_random_uuid(),
  external_ref     text not null unique,            -- the shop's order id, e.g. JI-1A2B3C4D
  branch_id        uuid references branches(id) on delete set null,
  status           text not null default 'new'
                   check (status in ('new', 'accepted', 'fulfilled', 'rejected', 'cancelled')),
  cancel_requested boolean not null default false,  -- shop cancelled AFTER we already invoiced
  payment_method   text not null check (payment_method in ('cod', 'transfer', 'card')),
  payment_status   text not null,
  customer_name    text,
  customer_phone   text,
  customer_address text,
  customer_notes   text,
  subtotal         numeric(12,2) not null check (subtotal >= 0),
  delivery_fee     numeric(12,2) not null default 0 check (delivery_fee >= 0),
  total_amount     numeric(12,2) not null check (total_amount >= 0),
  placed_at        timestamptz,
  received_at      timestamptz not null default now(),
  accepted_by      uuid references profiles(id) on delete set null,
  accepted_at      timestamptz,
  fulfilled_at     timestamptz,
  invoice_id       uuid references invoices(id) on delete set null,
  reject_reason    text,
  raw              jsonb not null                   -- the payload exactly as received
);
create index idx_online_orders_status   on online_orders(status, received_at desc);
create index idx_online_orders_branch   on online_orders(branch_id, received_at desc);

create table online_order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references online_orders(id) on delete cascade,
  sku         text,
  item_id     uuid references items(id) on delete set null,   -- null = SKU not matched (yet)
  name        text not null,
  unit_price  numeric(12,2) not null check (unit_price >= 0),
  quantity    numeric(12,3) not null check (quantity > 0)
);
create index idx_online_order_items_order on online_order_items(order_id);

-- ---------------------------------------------------------------------
-- RLS: same two-key model as the rest of the app (permission AND branch)
-- ---------------------------------------------------------------------
alter table shop_settings      enable row level security;
alter table online_orders      enable row level security;
alter table online_order_items enable row level security;

create policy shop_settings_select on shop_settings for select to authenticated
  using (has_permission('online_orders.view') or has_permission('branches.manage'));
create policy shop_settings_update on shop_settings for update to authenticated
  using (has_permission('branches.manage')) with check (has_permission('branches.manage'));

-- Orders with no branch yet (no default branch configured) are visible
-- only to people who can claim them (online_orders.manage).
create policy online_orders_select on online_orders for select to authenticated
  using (
    has_permission('online_orders.view')
    and (
      (branch_id is null and has_permission('online_orders.manage'))
      or (branch_id is not null and has_branch_access(branch_id))
    )
  );

-- Visibility of lines follows the parent order (its RLS applies in the subquery).
create policy online_order_items_select on online_order_items for select to authenticated
  using (exists (select 1 from online_orders o where o.id = order_id));

-- No insert/update/delete policies on the orders: every write goes through
-- the functions below, which re-check permission and branch access.
grant select on online_orders, online_order_items to authenticated;
grant select, update on shop_settings to authenticated;

-- The shop-sync Edge Function reads/writes these through the Data API as service_role.
-- (Not assumed: newer Supabase projects do not auto-grant new tables; see 0009.)
grant select on items, branches, branch_item_stock to service_role;
grant select, update on shop_settings to service_role;

-- ---------------------------------------------------------------------
-- receive_online_order(payload)  — called ONLY by the shop-webhook function
-- (service role). Idempotent; safe against the shop's retries.
-- payload = { "event": "order.confirmed" | "order.cancelled", "order": { ... } }
-- ---------------------------------------------------------------------
create or replace function receive_online_order(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event   text  := payload->>'event';
  o         jsonb := payload->'order';
  v_ref     text  := o->>'id';
  v_row     online_orders%rowtype;
  v_id      uuid;
  v_branch  uuid;
  v_result  text;
  line      jsonb;
begin
  if v_ref is null or btrim(v_ref) = '' then
    raise exception 'order.id is required';
  end if;
  if v_event is null or v_event not in ('order.confirmed', 'order.cancelled') then
    raise exception 'Unsupported event: %', coalesce(v_event, '(none)');
  end if;
  if jsonb_typeof(o->'items') is distinct from 'array' or jsonb_array_length(o->'items') = 0 then
    raise exception 'order.items must be a non-empty array';
  end if;

  select * into v_row from online_orders where external_ref = v_ref for update;

  if found then
    v_id := v_row.id;
    if v_event = 'order.cancelled' then
      if v_row.status in ('new', 'accepted') then
        update online_orders set status = 'cancelled' where id = v_id;
        v_result := 'cancelled';
      elsif v_row.status = 'fulfilled' then
        -- An invoice already exists: a person must issue the refund / credit note.
        update online_orders set cancel_requested = true where id = v_id;
        v_result := 'cancel_requested';
      else
        v_result := 'ignored';
      end if;
    else
      -- Re-delivery, or "confirmed" again after payment was verified.
      update online_orders
         set payment_status = coalesce(o->>'paymentStatus', payment_status)
       where id = v_id and status in ('new', 'accepted');
      v_result := 'duplicate';
    end if;
    return jsonb_build_object('ok', true, 'id', v_id, 'result', v_result);
  end if;

  select default_branch_id into v_branch from shop_settings where id;

  insert into online_orders (
    external_ref, branch_id, status, payment_method, payment_status,
    customer_name, customer_phone, customer_address, customer_notes,
    subtotal, delivery_fee, total_amount, placed_at, raw
  ) values (
    v_ref, v_branch,
    case when v_event = 'order.cancelled' then 'cancelled' else 'new' end,
    o->>'paymentMethod', coalesce(o->>'paymentStatus', 'unpaid'),
    o#>>'{customer,name}', o#>>'{customer,phone}', o#>>'{customer,address}', o#>>'{customer,notes}',
    (o->>'subtotal')::numeric, coalesce((o->>'deliveryFee')::numeric, 0), (o->>'total')::numeric,
    (o->>'createdAt')::timestamptz, payload
  ) returning id into v_id;

  for line in select * from jsonb_array_elements(o->'items') loop
    insert into online_order_items (order_id, sku, item_id, name, unit_price, quantity)
    values (
      v_id,
      nullif(btrim(line->>'sku'), ''),
      (select i.id from items i where i.sku = nullif(btrim(line->>'sku'), '') and i.is_active limit 1),
      line->>'name',
      (line->>'price')::numeric,
      (line->>'qty')::numeric
    );
  end loop;

  -- user_id stays null: this is a system event from the website, not a person.
  insert into activity_log (branch_id, action, entity_type, entity_id, details)
  values (v_branch, 'online_order.received', 'online_order', v_id::text,
          jsonb_build_object('external_ref', v_ref, 'event', v_event, 'total', o->>'total', 'source', 'online shop'));

  return jsonb_build_object('ok', true, 'id', v_id, 'result', 'created');
end;
$$;

revoke all on function receive_online_order(jsonb) from public, anon, authenticated;
grant execute on function receive_online_order(jsonb) to service_role;

-- ---------------------------------------------------------------------
-- accept_online_order — a branch claims the order (it will bake / pack it)
-- ---------------------------------------------------------------------
create or replace function accept_online_order(p_order_id uuid, p_branch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  online_orders%rowtype;
  v_branch uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if not has_permission('online_orders.manage') then
    raise exception 'Missing permission: online_orders.manage';
  end if;

  select * into v_order from online_orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if v_order.status <> 'new' then
    raise exception 'Only new orders can be accepted (this one is %).', v_order.status;
  end if;

  v_branch := coalesce(p_branch_id, v_order.branch_id);
  if v_branch is null or not has_branch_access(v_branch) then
    raise exception 'No access to this branch.';
  end if;
  -- An order already routed to a branch can only be re-routed by someone with access to it.
  if v_order.branch_id is not null and not has_branch_access(v_order.branch_id) then
    raise exception 'No access to this order.';
  end if;

  update online_orders
     set status = 'accepted', branch_id = v_branch, accepted_by = auth.uid(), accepted_at = now()
   where id = p_order_id;

  perform log_activity('online_order.accept', v_branch, 'online_order', p_order_id::text,
                       jsonb_build_object('external_ref', v_order.external_ref));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- reject_online_order — only before it is invoiced
-- NOTE: the storefront has no inbound "cancel" endpoint. After rejecting,
-- cancel the order in the website's /admin so its stock is released and
-- (if already paid online) refund the customer.
-- ---------------------------------------------------------------------
create or replace function reject_online_order(p_order_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order online_orders%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if not has_permission('online_orders.manage') then
    raise exception 'Missing permission: online_orders.manage';
  end if;

  select * into v_order from online_orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if v_order.status not in ('new', 'accepted') then
    raise exception 'This order can no longer be rejected (it is %).', v_order.status;
  end if;
  if v_order.branch_id is not null and not has_branch_access(v_order.branch_id) then
    raise exception 'No access to this order.';
  end if;
  if v_order.branch_id is null and not has_permission('online_orders.manage') then
    raise exception 'No access to this order.';
  end if;

  update online_orders set status = 'rejected', reject_reason = nullif(btrim(p_reason), '') where id = p_order_id;

  perform log_activity('online_order.reject', v_order.branch_id, 'online_order', p_order_id::text,
                       jsonb_build_object('external_ref', v_order.external_ref, 'reason', p_reason,
                                          'payment_status', v_order.payment_status));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- fulfil_online_order — creates the real invoice (hand-over / dispatch).
-- Goes through sync_invoice(): same numbering, stock deduction, audit log.
-- The order id doubles as client_ref, so calling this twice can never
-- create two invoices.
-- ---------------------------------------------------------------------
create or replace function fulfil_online_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order     online_orders%rowtype;
  v_rate      numeric;
  v_subtotal  numeric(12,2);
  v_tax       numeric(12,2);
  v_missing   text;
  v_items     jsonb;
  v_payments  jsonb := '[]'::jsonb;
  v_result    jsonb;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if not has_permission('online_orders.manage') then
    raise exception 'Missing permission: online_orders.manage';
  end if;

  select * into v_order from online_orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;

  -- Already done: answer with what exists (idempotent).
  if v_order.status = 'fulfilled' then
    return jsonb_build_object('ok', true, 'invoice_id', v_order.invoice_id, 'already', true);
  end if;
  if v_order.status <> 'accepted' then
    raise exception 'Accept the order first (it is %).', v_order.status;
  end if;
  if v_order.branch_id is null or not has_branch_access(v_order.branch_id) then
    raise exception 'No access to this branch.';
  end if;

  -- Re-try matching SKUs that were added to the POS after the order arrived.
  update online_order_items oi
     set item_id = i.id
    from items i
   where oi.order_id = p_order_id and oi.item_id is null
     and oi.sku is not null and i.sku = oi.sku and i.is_active;

  select string_agg(coalesce(sku, name), ', ') into v_missing
    from online_order_items where order_id = p_order_id and item_id is null;
  if v_missing is not null then
    raise exception 'These lines are not in the POS catalogue (match the SKU first): %', v_missing;
  end if;

  select coalesce(tax_rate_percent, 0) / 100 into v_rate from branches where id = v_order.branch_id;
  if v_rate > 0 then
    v_subtotal := round(v_order.total_amount / (1 + v_rate), 2);   -- prices include tax
    v_tax      := v_order.total_amount - v_subtotal;
    if v_tax > 0 and not has_permission('bills.tax') then
      raise exception 'Fulfilling a taxable order needs the "Apply tax" permission.';
    end if;
  else
    v_subtotal := v_order.total_amount;
    v_tax      := 0;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', oi.item_id, 'item_name', oi.name, 'quantity', oi.quantity,
           'unit_price', oi.unit_price, 'line_total', round(oi.unit_price * oi.quantity, 2)
         ) order by oi.id), '[]'::jsonb)
    into v_items
    from online_order_items oi where oi.order_id = p_order_id;

  if v_order.delivery_fee > 0 then
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'item_id', null, 'item_name', 'Delivery fee', 'quantity', 1,
      'unit_price', v_order.delivery_fee, 'line_total', v_order.delivery_fee));
  end if;

  if v_order.total_amount > 0 then
    v_payments := jsonb_build_array(jsonb_build_object(
      'mode', case v_order.payment_method
                when 'card' then 'card' when 'transfer' then 'bank_transfer' else 'cash' end,
      'amount', v_order.total_amount));
  end if;

  v_result := sync_invoice(jsonb_build_object(
    'branch_id', v_order.branch_id,
    'client_ref', v_order.id,
    'status', 'completed',
    'customer_name', v_order.customer_name,
    'customer_phone', v_order.customer_phone,
    'subtotal', v_subtotal,
    'discount_amount', 0,
    'tax_amount', v_tax,
    'total_amount', v_order.total_amount,
    'items', v_items,
    'payments', v_payments
  ));

  update online_orders
     set status = 'fulfilled', fulfilled_at = now(), invoice_id = (v_result->>'id')::uuid
   where id = p_order_id;

  perform log_activity('online_order.fulfil', v_order.branch_id, 'online_order', p_order_id::text,
                       jsonb_build_object('external_ref', v_order.external_ref,
                                          'invoice_number', v_result->>'invoice_number'));

  return jsonb_build_object('ok', true, 'invoice_id', v_result->>'id',
                            'invoice_number', v_result->>'invoice_number');
end;
$$;

grant execute on function accept_online_order(uuid, uuid)  to authenticated;
grant execute on function reject_online_order(uuid, text)  to authenticated;
grant execute on function fulfil_online_order(uuid)        to authenticated;

-- Staff clear the "cancel requested" flag once they have refunded / credited.
create or replace function ack_online_cancel(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_branch uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if not has_permission('online_orders.manage') then
    raise exception 'Missing permission: online_orders.manage';
  end if;
  select branch_id into v_branch from online_orders where id = p_order_id;
  if v_branch is null or not has_branch_access(v_branch) then raise exception 'No access to this order.'; end if;
  update online_orders set cancel_requested = false where id = p_order_id;
  perform log_activity('online_order.cancel_ack', v_branch, 'online_order', p_order_id::text, null);
end;
$$;
grant execute on function ack_online_cancel(uuid) to authenticated;
