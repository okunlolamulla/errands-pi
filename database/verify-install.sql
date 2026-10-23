-- Run after supabase-setup.sql to confirm everything was created. Each query says what to expect.

-- 1) Tables: expect 10 rows (carts, customers, errand_requests, errand_status_history, order_items, payments, product_categories, products, services, users)
select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('users', 'errand_requests', 'errand_status_history', 'payments', 'services', 'customers', 'products', 'product_categories', 'order_items', 'carts')
order by table_name;

-- 2) Status lists: expect errand_status with 9 values in this order and user_role with customer, agent, admin
select t.typname as type, string_agg(e.enumlabel, ', ' order by e.enumsortorder) as values
from pg_type t join pg_enum e on e.enumtypid = t.oid
where t.typname in ('user_role', 'errand_status') group by t.typname;

-- 3) Functions: expect 6 rows (admin_overview, confirm_payment, generate_errand_id, link_customer, phone_key, set_updated_at)
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('generate_errand_id', 'confirm_payment', 'set_updated_at', 'admin_overview', 'link_customer', 'phone_key')
order by p.proname;

-- 4) Security: expect 6 rows, all with row_level_security = true
select relname as table_name, relrowsecurity as row_level_security from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('users', 'errand_requests', 'errand_status_history', 'payments', 'services', 'customers') order by relname;

-- 5) Photo folders: expect 2 rows (proofs, requests), both with public = false
select id, public from storage.buckets where id in ('proofs', 'requests') order by id;

-- 6) The ID generator: expect something like EB-K7M2QX (it does not save anything)
select public.generate_errand_id() as sample_errand_id;

-- 7) Services: expect 9 rows, all is_active = true
select name, is_active from public.services order by sort_order;

-- 8) Dashboard totals: expect one row of JSON with customers, orders, revenue, ... (zeros on a new install)
select public.admin_overview() as overview;

-- 9) Shop: expect 14 categories and 94 products on a new install
select (select count(*) from public.product_categories) as categories, (select count(*) from public.products) as products;
