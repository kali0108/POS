\set ON_ERROR_STOP on
-- ---- seed ----
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1','owner@x.com'),
  ('00000000-0000-0000-0000-0000000000b2','cashier@x.com'),
  ('00000000-0000-0000-0000-0000000000c3','otherbranch@x.com');
insert into profiles (id, full_name, email, is_owner) values
  ('00000000-0000-0000-0000-0000000000a1','Owner','owner@x.com', true)
  on conflict (id) do update set is_owner = true, is_active = true;
insert into branches (id, code, name, tax_label, tax_rate_percent, currency_code, currency_symbol) values
  ('11111111-1111-1111-1111-111111111111','RUH','Riyadh','VAT',15,'SAR','SAR'),
  ('22222222-2222-2222-2222-222222222222','JED','Jeddah','VAT',15,'SAR','SAR');
insert into items (id, sku, name, unit_price) values
  ('aaaaaaaa-0000-0000-0000-000000000001','BRG-01','Burger',    10.00),
  ('aaaaaaaa-0000-0000-0000-000000000002','CKE-01','Cake',      50.00);
insert into branch_item_stock (branch_id,item_id,quantity) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',20);
update shop_settings set default_branch_id='11111111-1111-1111-1111-111111111111';

-- a cashier with online_orders.manage + bills.create + bills.tax, branch RUH only
insert into profiles (id, full_name, email, role_template_id) select '00000000-0000-0000-0000-0000000000b2','Cashier','cashier@x.com', id from role_templates where name='Cashier'
  on conflict (id) do update set role_template_id = excluded.role_template_id, is_owner=false, is_active=true;
insert into user_branches (user_id, branch_id) values ('00000000-0000-0000-0000-0000000000b2','11111111-1111-1111-1111-111111111111');
insert into user_permission_overrides (user_id, permission_key, allowed) values
  ('00000000-0000-0000-0000-0000000000b2','online_orders.view',true),
  ('00000000-0000-0000-0000-0000000000b2','online_orders.manage',true),
  ('00000000-0000-0000-0000-0000000000b2','bills.create',true),
  ('00000000-0000-0000-0000-0000000000b2','bills.tax',true);
-- another user, other branch, same permissions (must NOT see RUH orders)
insert into profiles (id, full_name, email, role_template_id) select '00000000-0000-0000-0000-0000000000c3','Other','otherbranch@x.com', id from role_templates where name='Cashier'
  on conflict (id) do update set role_template_id = excluded.role_template_id, is_owner=false, is_active=true;
insert into user_branches (user_id, branch_id) values ('00000000-0000-0000-0000-0000000000c3','22222222-2222-2222-2222-222222222222');
insert into user_permission_overrides (user_id, permission_key, allowed) values
  ('00000000-0000-0000-0000-0000000000c3','online_orders.view',true),
  ('00000000-0000-0000-0000-0000000000c3','online_orders.manage',true),
  ('00000000-0000-0000-0000-0000000000c3','bills.create',true);

-- ---- 1. webhook arrives (service role) ----
set role service_role;
select receive_online_order($j${
 "event":"order.confirmed","sentAt":"2026-11-13T10:00:00Z",
 "order":{"id":"JI-AAAA1111","createdAt":"2026-11-13T09:59:00Z","paymentMethod":"cod","paymentStatus":"unpaid",
  "customer":{"name":"Sara","phone":"0500000000","address":"Makkah, Al Aziziyah 12"},
  "items":[{"sku":"BRG-01","slug":"burger","name":"Burger","price":23,"qty":2},{"sku":"CKE-01","slug":"cake","name":"Cake","price":115,"qty":1}],
  "subtotal":161,"deliveryFee":0,"total":161}}$j$::jsonb) as first_delivery;
-- duplicate delivery must not create a second row
select receive_online_order($j${"event":"order.confirmed","order":{"id":"JI-AAAA1111","paymentMethod":"cod","paymentStatus":"unpaid","items":[{"sku":"BRG-01","name":"Burger","price":23,"qty":2}],"subtotal":46,"total":46}}$j$::jsonb) as duplicate_delivery;
reset role;
do $$ begin
  assert (select count(*) from online_orders) = 1, 'duplicate webhook created a 2nd order';
  assert (select count(*) from online_order_items) = 2, 'items duplicated/missing';
  assert (select count(*) from online_order_items where item_id is not null) = 2, 'SKUs not matched';
  assert (select branch_id from online_orders) = '11111111-1111-1111-1111-111111111111', 'default branch not applied';
  assert (select total_amount from online_orders) = 161, 'duplicate delivery overwrote the original';
end $$;

-- ---- 2. branch isolation ----
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c3';
do $$ begin assert (select count(*) from online_orders) = 0, 'other branch can see RUH order'; end $$;
do $$ declare ok boolean := false; begin
  begin perform accept_online_order((select id from online_orders limit 1)); exception when others then ok := true; end;
  assert ok, 'other branch could accept RUH order';
end $$;
reset role;

-- ---- 3. RUH cashier: cannot fulfil before accepting, then accept + fulfil ----
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
do $$ begin assert (select count(*) from online_orders) = 1, 'cashier cannot see own branch order'; end $$;
do $$ declare ok boolean := false; begin
  begin perform fulfil_online_order((select id from online_orders limit 1)); exception when others then ok := true; end;
  assert ok, 'fulfilled without accepting';
end $$;
select accept_online_order((select id from online_orders limit 1)) as accepted;
select fulfil_online_order((select id from online_orders limit 1)) as fulfilled;
select fulfil_online_order((select id from online_orders limit 1)) as fulfilled_again;
reset role;

do $$ declare inv invoices%rowtype; begin
  select * into inv from invoices;
  assert (select count(*) from invoices) = 1, 'second fulfil created a second invoice';
  assert inv.status = 'completed', 'invoice not completed';
  assert inv.total_amount = 161.00, 'invoice total != amount customer paid';
  assert inv.subtotal = 140.00 and inv.tax_amount = 21.00, format('tax split wrong: %s / %s', inv.subtotal, inv.tax_amount);
  assert inv.invoice_number like 'RUH-%', 'invoice number not assigned by server';
  assert (select quantity from branch_item_stock where item_id='aaaaaaaa-0000-0000-0000-000000000001') = 18, 'stock not deducted';
  assert (select mode from payments) = 'cash' and (select amount from payments) = 161, 'COD payment wrong';
  assert (select status from online_orders) = 'fulfilled', 'order status';
  assert (select invoice_id from online_orders) = inv.id, 'order not linked to invoice';
  raise notice 'invoice % total % = subtotal % + tax %', inv.invoice_number, inv.total_amount, inv.subtotal, inv.tax_amount;
end $$;

-- ---- 4. shop cancels AFTER invoicing -> flagged, never silently voided ----
set role service_role;
select receive_online_order('{"event":"order.cancelled","order":{"id":"JI-AAAA1111","paymentMethod":"cod","items":[{"name":"x","price":1,"qty":1}],"subtotal":1,"total":1}}'::jsonb) as cancel_after_invoice;
reset role;
do $$ begin
  assert (select cancel_requested from online_orders) , 'cancel after invoice not flagged';
  assert (select status from invoices) = 'completed', 'invoice was altered by a cancel event';
end $$;

-- ---- 5. unmatched SKU blocks fulfilment, fixed later by adding the SKU ----
set role service_role;
select receive_online_order('{"event":"order.confirmed","order":{"id":"JI-BBBB2222","paymentMethod":"card","paymentStatus":"paid","deliveryFee":10,"items":[{"sku":"NEW-99","name":"New thing","price":30,"qty":1}],"subtotal":30,"total":40}}'::jsonb);
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
select accept_online_order((select id from online_orders where external_ref='JI-BBBB2222'));
do $$ declare ok boolean := false; msg text; begin
  begin perform fulfil_online_order((select id from online_orders where external_ref='JI-BBBB2222')); exception when others then ok := true; msg := sqlerrm; end;
  assert ok, 'unmatched SKU did not block fulfilment'; raise notice 'blocked as expected: %', msg;
end $$;
reset role;
insert into items (sku,name,unit_price) values ('NEW-99','New thing',26.09);
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
select fulfil_online_order((select id from online_orders where external_ref='JI-BBBB2222')) as fulfilled_after_sku_added;
reset role;
do $$ begin
  assert (select count(*) from invoice_items where item_name='Delivery fee') = 1, 'delivery line missing';
  assert (select total_amount from invoices where invoice_number like 'RUH-%' order by created_at desc limit 1) = 40.00;
  assert (select mode from payments order by created_at desc limit 1) = 'card';
end $$;
select 'ALL SHOP INTEGRATION ASSERTIONS PASSED' as result;
