-- Errand Boys: launch-phase schema (Supabase PostgreSQL)
-- Run in the Supabase SQL editor, or: psql "$DATABASE_URL" -f sql/001_schema.sql

create extension if not exists pgcrypto;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'user_role' and typnamespace = 'public'::regnamespace) then
    create type public.user_role as enum ('customer', 'agent', 'admin');
  end if;
  if not exists (select 1 from pg_type where typname = 'errand_status' and typnamespace = 'public'::regnamespace) then
    create type public.errand_status as enum
      ('Pending Review', 'Quoted', 'Paid', 'Assigned', 'On the way', 'In Progress', 'Proof Uploaded', 'Completed', 'Closed');
  end if;
end $$;

-- ---------------------------------------------------------------- users
-- id matches the Supabase Auth user, so a login token maps straight to a role.
create table public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null check (length(trim(name)) between 2 and 100),
  email       text not null,
  phone       text,
  role        public.user_role not null default 'customer',
  is_active   boolean not null default true,   -- inactive agents are hidden from the assign dropdown
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index users_email_lower_key on public.users (lower(email));
create index users_role_idx on public.users (role);

-- ----------------------------------------------------- errand id generator
-- EB-XXXXXX: 6 random characters from a 31-character alphabet (no 0/O/1/I/L).
-- ~887 million combinations. The loop plus the primary key guarantee uniqueness;
-- the API also retries on the rare concurrent clash (error code 23505).
create or replace function public.generate_errand_id() returns text
language plpgsql as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  candidate text;
  i int;
begin
  loop
    candidate := 'EB-';
    for i in 1..6 loop
      candidate := candidate ||
        substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % length(alphabet)), 1);
    end loop;
    exit when not exists (select 1 from public.errand_requests where errand_id = candidate);
  end loop;
  return candidate;
end $$;

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ------------------------------------------------------ errand_requests
create table public.errand_requests (
  errand_id          text primary key default public.generate_errand_id(),
  service_type       text not null,
  task_description   text not null check (length(trim(task_description)) >= 5),
  pickup_location    text,
  delivery_location  text,
  date_time          timestamptz,                       -- when the customer wants it done
  contact_info       jsonb not null,                    -- {"name": "...", "phone": "...", "email": "..."}
  status             public.errand_status not null default 'Pending Review',
  quote_amount       numeric(12,2) check (quote_amount is null or quote_amount > 0),
  quote_currency     text not null default 'NGN' check (quote_currency in ('NGN', 'USD')),
  payment_link       text,                              -- Paystack checkout link sent to the customer
  assigned_agent_id  uuid references public.users(id) on delete restrict,
  proof_notes        text,
  proof_urls         text[] not null default '{}',      -- private Storage paths in the "proofs" bucket
  details            jsonb not null default '{}'::jsonb, -- extra form answers, e.g. grocery: shopping_list, brands, budget, supermarket, landmark, instructions
  request_files      text[] not null default '{}',      -- customer photos (e.g. shopping list), private "requests" bucket
  payment_reference  text unique,                       -- Paystack reference (manual for now)
  paid_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint errand_id_format check (errand_id ~ '^EB-[A-HJKMNP-Z2-9]{6}$'),
  constraint contact_info_shape check (contact_info ? 'name' and contact_info ? 'phone'),
  -- ::text keeps these checks safe to add right after ALTER TYPE ... ADD VALUE (see 002_upgrade.sql)
  constraint paid_needs_quote check
    (quote_amount is not null or status::text in ('Pending Review', 'Quoted', 'Closed')),
  constraint work_needs_agent check
    (assigned_agent_id is not null or status::text not in ('Assigned', 'On the way', 'In Progress', 'Proof Uploaded', 'Completed'))
);
create index errand_requests_status_idx on public.errand_requests (status);
create index errand_requests_agent_idx  on public.errand_requests (assigned_agent_id);
create index errand_requests_created_idx on public.errand_requests (created_at desc);

create trigger errand_requests_updated before update on public.errand_requests
  for each row execute function public.set_updated_at();
create trigger users_updated before update on public.users
  for each row execute function public.set_updated_at();

-- ------------------------------------------------- errand_status_history
-- Audit trail (who changed what, when). Optional but cheap, and useful for support and disputes.
create table public.errand_status_history (
  id           bigint generated always as identity primary key,
  errand_id    text not null references public.errand_requests(errand_id) on delete cascade,
  from_status  public.errand_status,
  to_status    public.errand_status not null,
  actor_id     uuid references public.users(id) on delete set null,
  note         text,
  created_at   timestamptz not null default now()
);
create index errand_status_history_errand_idx on public.errand_status_history (errand_id, created_at);

-- ------------------------------------------------------------ payments

create table if not exists public.payments (
  id               bigint generated always as identity primary key,
  errand_id        text not null references public.errand_requests(errand_id) on delete cascade,
  provider         text not null check (provider in ('paystack', 'flutterwave', 'mock')),
  reference        text not null unique,                 -- our reference, sent to the gateway
  amount           numeric(12,2) not null check (amount > 0),
  currency         text not null check (currency in ('NGN', 'USD')),
  checkout_url     text,
  -- pending : link created, not paid yet
  -- paid    : confirmed and applied to the errand
  -- stale   : money arrived but the quote changed / the errand moved on (needs a human)
  -- mismatch: amount or currency differed from what we asked for (needs a human)
  -- resolved: a human reviewed a stale/mismatch payment
  status           text not null default 'pending' check (status in ('pending', 'paid', 'stale', 'mismatch', 'resolved')),
  provider_txn_id  text,
  paid_at          timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists payments_errand_idx on public.payments (errand_id);
create index if not exists payments_status_idx on public.payments (status);
alter table public.payments enable row level security;   -- no policies: only the API (service role) can touch it

-- Applies a confirmed payment in ONE transaction, so a webhook that arrives twice
-- (gateways retry) or two at once can never pay an errand twice.
-- Returns: 'paid' | 'already_processed' | 'unknown_reference' | 'mismatch' | 'stale'
create or replace function public.confirm_payment(
  p_provider text, p_reference text, p_amount_minor bigint, p_currency text, p_txn_id text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  pay public.payments;
  err public.errand_requests;
begin
  select * into pay from public.payments
   where reference = p_reference and provider = p_provider for update;
  if not found then return 'unknown_reference'; end if;
  if pay.status <> 'pending' then return 'already_processed'; end if;

  if round(pay.amount * 100)::bigint <> p_amount_minor or pay.currency <> p_currency then
    update public.payments set status = 'mismatch', provider_txn_id = p_txn_id, paid_at = now() where id = pay.id;
    return 'mismatch';
  end if;

  select * into err from public.errand_requests where errand_id = pay.errand_id for update;
  if err.status::text <> 'Quoted' or err.payment_reference is distinct from pay.reference then
    update public.payments set status = 'stale', provider_txn_id = p_txn_id, paid_at = now() where id = pay.id;
    return 'stale';
  end if;

  update public.payments set status = 'paid', provider_txn_id = p_txn_id, paid_at = now() where id = pay.id;
  update public.errand_requests set status = 'Paid', paid_at = now() where errand_id = err.errand_id;
  insert into public.errand_status_history (errand_id, from_status, to_status, note)
    values (err.errand_id, 'Quoted', 'Paid', 'Paid via ' || p_provider || ' (' || p_reference || ')');
  return 'paid';
end $$;

-- PostgREST exposes public functions as /rpc/... Only the server may call this one.
revoke all on function public.confirm_payment(text, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.confirm_payment(text, text, bigint, text, text) to service_role;

-- ======================================================= admin controls (006)

-- ------------------------------------------------- forced password change
-- The default admin login is created with this flag on: the dashboard makes the person choose a new password at first sign-in.
alter table public.users add column if not exists must_change_password boolean not null default false;

-- ------------------------------------------------------------ services
create table if not exists public.services (
  id          int generated always as identity primary key,
  name        text not null unique,                 -- must match the service_type the website sends
  slug        text not null unique,
  description text,
  icon        text,
  base_fee    numeric(12,2) check (base_fee is null or base_fee >= 0),  -- optional "from" price shown to staff
  currency    text not null default 'NGN' check (currency in ('NGN', 'USD')),
  is_active   boolean not null default true,        -- off = the API refuses new requests for this service
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.services enable row level security;

insert into public.services (name, slug, description, icon, sort_order) values
  ('Grocery shopping',    'grocery-shopping',    'We shop your list at the market or supermarket of your choice and deliver it to your door.', '🛒', 1),
  ('Moving service',      'moving-service',      'Packing help, loading and moving of your belongings from one home or office to another.',    '🚚', 2),
  ('Pharmacy pickup',     'pharmacy-pickup',     'We collect your prescription or medicines from a pharmacy and bring them to you.',           '💊', 3),
  ('Office errand',       'office-errand',       'Document drop-offs, collections, bank runs and other office tasks done for you.',            '🏢', 4),
  ('House hunting',       'house-hunting',       'We scout and view properties that match your budget and area, and report back with photos.',  '🏠', 5),
  ('Verification errand', 'verification-errand', 'We visit an address, business or person and confirm that things are as they were described.', '✅', 6),
  ('Custom errand',       'custom-errand',       'Anything else you need done: tell us the task and we will quote you.',                       '✨', 7),
  ('Car service',         'car-service',         'We take your car for servicing, washing, inspection or paperwork and bring it back.',        '🚗', 8),
  ('Care giving services','care-giving-services','Trusted help to look after an elderly person, a child or a patient at home.',               '🤝', 9)
on conflict (name) do nothing;

drop trigger if exists services_updated on public.services;
create trigger services_updated before update on public.services
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------- customers
create or replace function public.phone_key(p text) returns text
language sql immutable as $$ select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '') $$;

create table if not exists public.customers (
  id          bigint generated always as identity primary key,
  phone_key   text not null unique,                 -- last 10 digits of the phone number: how repeat customers are recognised
  name        text not null,
  phone       text not null,
  email       text,
  notes       text,                                 -- staff notes
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.customers enable row level security;
drop trigger if exists customers_updated on public.customers;
create trigger customers_updated before update on public.customers
  for each row execute function public.set_updated_at();

alter table public.errand_requests add column if not exists customer_id bigint references public.customers(id) on delete set null;
create index if not exists errand_requests_customer_idx on public.errand_requests (customer_id);

-- Every new errand finds or creates its customer.
create or replace function public.link_customer() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; cid bigint;
begin
  k := public.phone_key(new.contact_info->>'phone');
  if k is null then return new; end if;
  insert into public.customers (phone_key, name, phone, email)
    values (k, new.contact_info->>'name', new.contact_info->>'phone', nullif(new.contact_info->>'email', ''))
  on conflict (phone_key) do update
    set name = excluded.name,
        email = coalesce(excluded.email, public.customers.email)
  returning id into cid;
  new.customer_id := cid;
  return new;
end $$;
drop trigger if exists errand_requests_link_customer on public.errand_requests;
create trigger errand_requests_link_customer before insert on public.errand_requests
  for each row execute function public.link_customer();

-- Fill in customers for errands that already exist (newest details win).
insert into public.customers (phone_key, name, phone, email)
select distinct on (public.phone_key(contact_info->>'phone'))
       public.phone_key(contact_info->>'phone'), contact_info->>'name', contact_info->>'phone', nullif(contact_info->>'email', '')
  from public.errand_requests
 where public.phone_key(contact_info->>'phone') is not null
 order by public.phone_key(contact_info->>'phone'), created_at desc
on conflict (phone_key) do nothing;

update public.errand_requests e set customer_id = c.id
  from public.customers c
 where e.customer_id is null and c.phone_key = public.phone_key(e.contact_info->>'phone');

-- ------------------------------------------------------------ approval
alter table public.errand_requests
  add column if not exists approval_status text not null default 'pending',
  add column if not exists approval_note   text,
  add column if not exists approval_by     uuid references public.users(id) on delete set null,
  add column if not exists approval_at     timestamptz;
do $$ begin
  alter table public.errand_requests add constraint approval_status_values
    check (approval_status in ('pending', 'approved', 'disapproved'));
exception when duplicate_object then null; end $$;
create index if not exists errand_requests_approval_idx on public.errand_requests (approval_status);

-- Errands that were already moving before this feature existed count as approved.
update public.errand_requests set approval_status = 'approved', approval_at = coalesce(approval_at, updated_at)
 where approval_status = 'pending' and status::text not in ('Pending Review', 'Closed');

-- ------------------------------------------------------------ payments
alter table public.payments
  add column if not exists gateway_status text,        -- what the gateway itself said when staff pressed "Check with Paystack"
  add column if not exists verified_at timestamptz;

-- ------------------------------------------------- dashboard overview
create or replace view public.customer_summary as
select c.id, c.name, c.phone, c.email, c.notes, c.created_at,
       count(e.errand_id)                                                        as orders,
       count(e.errand_id) filter (where e.paid_at is not null)                   as paid_orders,
       coalesce(sum(e.quote_amount) filter (where e.paid_at is not null and e.quote_currency = 'NGN'), 0) as spent_ngn,
       coalesce(sum(e.quote_amount) filter (where e.paid_at is not null and e.quote_currency = 'USD'), 0) as spent_usd,
       max(e.created_at)                                                         as last_order_at
  from public.customers c
  left join public.errand_requests e on e.customer_id = c.id
 group by c.id;
revoke all on public.customer_summary from public, anon, authenticated;
grant select on public.customer_summary to service_role;

create or replace function public.admin_overview() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'customers',         (select count(*) from customers),
    'orders',            (select count(*) from errand_requests),
    'paid_orders',       (select count(*) from errand_requests where paid_at is not null),
    'awaiting_approval', (select count(*) from errand_requests where approval_status = 'pending' and status::text <> 'Closed'),
    'active_orders',     (select count(*) from errand_requests where status::text not in ('Completed', 'Closed')),
    'completed_orders',  (select count(*) from errand_requests where status::text in ('Completed', 'Closed') and approval_status <> 'disapproved'),
    'payment_issues',    (select count(*) from payments where status in ('stale', 'mismatch')),
    'revenue',           coalesce((select jsonb_object_agg(quote_currency, total)
                                     from (select quote_currency, sum(quote_amount) total from errand_requests
                                            where paid_at is not null group by quote_currency) r), '{}'::jsonb),
    'revenue_30d',       coalesce((select jsonb_object_agg(quote_currency, total)
                                     from (select quote_currency, sum(quote_amount) total from errand_requests
                                            where paid_at >= now() - interval '30 days' group by quote_currency) r), '{}'::jsonb),
    'by_status',         coalesce((select jsonb_object_agg(status, n) from (select status::text status, count(*) n from errand_requests group by 1) s), '{}'::jsonb),
    'by_service',        coalesce((select jsonb_agg(jsonb_build_object('service', service_type, 'orders', n, 'revenue_ngn', rev) order by n desc)
                                     from (select service_type, count(*) n,
                                                  coalesce(sum(quote_amount) filter (where paid_at is not null and quote_currency = 'NGN'), 0) rev
                                             from errand_requests group by 1) s), '[]'::jsonb),
    'daily',             coalesce((select jsonb_agg(jsonb_build_object('day', d::date,
                                        'orders',  (select count(*) from errand_requests where created_at::date = d::date),
                                        'revenue', (select coalesce(sum(quote_amount), 0) from errand_requests where paid_at::date = d::date and quote_currency = 'NGN')) order by d)
                                     from generate_series(current_date - 13, current_date, interval '1 day') d), '[]'::jsonb)
  )
$$;
revoke all on function public.admin_overview() from public, anon, authenticated;
grant execute on function public.admin_overview() to service_role;

-- ======================================================= stock management and carts (007)
-- New installs get all of this from supabase-setup.sql already; run this file only on a database that was set up before.

create table if not exists public.product_categories (
  id          text primary key,                       -- e.g. 'alcohols'
  name        text not null,
  emoji       text,
  tint        text default '#eef0f6',
  age18       boolean not null default false,         -- asks buyers to confirm they are 18 or older
  img         text,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.products (
  id          text primary key,                       -- e.g. 'alcohols-1'
  category_id text not null references public.product_categories(id) on update cascade on delete restrict,
  name        text not null,
  size        text,
  price       numeric(12,2) not null check (price >= 0),
  was_price   numeric(12,2) check (was_price is null or was_price >= 0),   -- old price: shows as a Sale
  featured    boolean not null default false,
  is_new      boolean not null default false,
  img         text,                                   -- /assets/products/x.jpg on the website, or a full address
  in_stock    boolean not null default true,
  stock_qty   int check (stock_qty is null or stock_qty >= 0),  -- null = quantity not tracked
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists products_category_idx on public.products (category_id);

create table if not exists public.order_items (
  id          bigint generated always as identity primary key,
  errand_id   text not null references public.errand_requests(errand_id) on delete cascade,
  product_id  text references public.products(id) on delete set null,
  name        text not null,
  size        text,
  unit_price  numeric(12,2) not null,
  qty         int not null check (qty > 0),
  created_at  timestamptz not null default now()
);
create index if not exists order_items_errand_idx on public.order_items (errand_id);
create index if not exists order_items_product_idx on public.order_items (product_id);

create table if not exists public.carts (
  id             uuid primary key,                    -- made by the customer's browser
  items          jsonb not null default '[]'::jsonb,  -- [{id, name, size, price, qty}]
  item_count     int not null default 0,
  total          numeric(12,2) not null default 0,
  status         text not null default 'open' check (status in ('open', 'ordered')),
  errand_id      text references public.errand_requests(errand_id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists carts_status_idx on public.carts (status, updated_at desc);

alter table public.product_categories enable row level security;
alter table public.products           enable row level security;
alter table public.order_items        enable row level security;
alter table public.carts              enable row level security;

drop trigger if exists product_categories_updated on public.product_categories;
create trigger product_categories_updated before update on public.product_categories for each row execute function public.set_updated_at();
drop trigger if exists products_updated on public.products;
create trigger products_updated before update on public.products for each row execute function public.set_updated_at();
drop trigger if exists carts_updated on public.carts;
create trigger carts_updated before update on public.carts for each row execute function public.set_updated_at();

-- Public folder for product pictures uploaded from the admin dashboard.
insert into storage.buckets (id, name, public) values ('shop', 'shop', true) on conflict (id) do nothing;

-- Saves the items of a shop order and takes them off the stock, in one step.
-- p_items: [{"id": "<product id>", "qty": 2}, ...]. Raises 'OUT_OF_STOCK: <name>' or 'UNKNOWN_PRODUCT' if it cannot.
create or replace function public.place_order_items(p_errand_id text, p_items jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare it jsonb; pr public.products; q int;
begin
  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::int;
    if q is null or q < 1 or q > 99 then raise exception 'BAD_QUANTITY'; end if;
    select * into pr from public.products where id = it->>'id' for update;
    if not found then raise exception 'UNKNOWN_PRODUCT: %', it->>'id'; end if;
    if not pr.in_stock or (pr.stock_qty is not null and pr.stock_qty < q) then raise exception 'OUT_OF_STOCK: %', pr.name; end if;
    insert into public.order_items (errand_id, product_id, name, size, unit_price, qty) values (p_errand_id, pr.id, pr.name, pr.size, pr.price, q);
    if pr.stock_qty is not null then
      update public.products set stock_qty = stock_qty - q, in_stock = (stock_qty - q) > 0 where id = pr.id;
    end if;
  end loop;
end $$;
revoke all on function public.place_order_items(text, jsonb) from public, anon, authenticated;
grant execute on function public.place_order_items(text, jsonb) to service_role;

-- The starting shop (94 products in 14 categories). Prices are placeholders: edit them in the admin dashboard.
insert into public.product_categories (id, name, emoji, tint, age18, img, sort_order) values
  ('alcohols', 'Alcohols', '🍷', '#f3e3ea', true, '/assets/products/alcohols-1.jpg', 1),
  ('baby-care', 'Baby Care', '🍼', '#e3f0fb', false, '/assets/products/baby-care-1.jpg', 2),
  ('bath-soap', 'Bath Soap', '🧼', '#e6f4f1', false, '/assets/products/bath-soap-4.jpg', 3),
  ('body-care', 'Body Care', '🧴', '#fbeee3', false, '/assets/products/body-care-1.jpg', 4),
  ('cleaning', 'Cleaning', '🧽', '#e3eefb', false, '/assets/products/cleaning-2.jpg', 5),
  ('fragrance', 'Fragrance', '🌸', '#f7e6f3', false, '/assets/products/fragrance-1.jpg', 6),
  ('fruits', 'Fruits', '🍎', '#fde8e8', false, '/assets/products/fruits-1.jpg', 7),
  ('groceries', 'Groceries', '🛒', '#e8f5e3', false, '/assets/products/groceries-1.jpg', 8),
  ('hair-extension', 'Hair & Extension', '💇‍♀️', '#efe6f7', false, '/assets/products/hair-extension-3.jpg', 9),
  ('hair-care', 'Hair Care', '💆', '#f3ece3', false, '/assets/products/hair-care-1.jpg', 10),
  ('non-alcoholic', 'Non-Alcoholic Drinks', '🥤', '#e3f5fb', false, '/assets/products/non-alcoholic-3.jpg', 11),
  ('oral-care', 'Oral Care', '🪥', '#e3f1f5', false, '/assets/products/oral-care-3.jpg', 12),
  ('seasoning', 'Seasoning', '🧂', '#fbf3df', false, '/assets/products/seasoning-1.jpg', 13),
  ('skin-care', 'Skin Care', '✨', '#fdf0e6', false, '/assets/products/skin-care-1.jpg', 14)
on conflict (id) do nothing;

insert into public.products (id, category_id, name, size, price, was_price, featured, is_new, img, sort_order) values
  ('alcohols-1', 'alcohols', 'Red wine', '75cl', 8500, null, false, false, '/assets/products/alcohols-1.jpg', 1),
  ('alcohols-2', 'alcohols', 'White wine', '75cl', 8000, null, false, false, '/assets/products/alcohols-2.jpg', 2),
  ('alcohols-3', 'alcohols', 'Premium lager beer', '6 x 33cl', 5400, null, false, false, '/assets/products/alcohols-3.jpg', 3),
  ('alcohols-4', 'alcohols', 'Vodka', '70cl', 12000, null, false, false, '/assets/products/alcohols-4.jpg', 4),
  ('alcohols-5', 'alcohols', 'Whisky', '70cl', 22000, null, false, false, '/assets/products/alcohols-5.jpg', 5),
  ('alcohols-6', 'alcohols', 'Gin', '75cl', 9500, null, false, false, '/assets/products/alcohols-6.jpg', 6),
  ('alcohols-7', 'alcohols', 'Sparkling wine', '75cl', 15000, null, false, true, '/assets/products/alcohols-7.jpg', 7),
  ('baby-care-1', 'baby-care', 'Baby diapers (size 3)', '40 pieces', 14500, null, true, false, '/assets/products/baby-care-1.jpg', 8),
  ('baby-care-2', 'baby-care', 'Baby wipes', '80 pieces', 2500, null, false, false, '/assets/products/baby-care-2.jpg', 9),
  ('baby-care-3', 'baby-care', 'Baby lotion', '200ml', 3200, null, false, false, '/assets/products/baby-care-3.jpg', 10),
  ('baby-care-4', 'baby-care', 'Baby powder', '200g', 2200, null, false, false, '/assets/products/baby-care-4.jpg', 11),
  ('baby-care-5', 'baby-care', 'Baby shampoo', '200ml', 2800, null, false, false, '/assets/products/baby-care-5.jpg', 12),
  ('baby-care-6', 'baby-care', 'Feeding bottle', '250ml', 3000, null, false, false, '/assets/products/baby-care-6.jpg', 13),
  ('baby-care-7', 'baby-care', 'Infant formula', '400g', 9800, null, false, false, '/assets/products/baby-care-7.jpg', 14),
  ('bath-soap-1', 'bath-soap', 'Antibacterial bath soap', '4 bars', 2800, null, false, false, '/assets/products/bath-soap-1.jpg', 15),
  ('bath-soap-2', 'bath-soap', 'Moisturising soap bar', '150g', 900, null, false, false, '/assets/products/bath-soap-2.jpg', 16),
  ('bath-soap-3', 'bath-soap', 'Shea butter soap', '200g', 1500, null, false, false, '/assets/products/bath-soap-3.jpg', 17),
  ('bath-soap-4', 'bath-soap', 'Liquid body wash', '500ml', 4200, null, false, false, '/assets/products/bath-soap-4.jpg', 18),
  ('bath-soap-5', 'bath-soap', 'African black soap', '250g', 1200, null, false, false, '/assets/products/bath-soap-5.jpg', 19),
  ('bath-soap-6', 'bath-soap', 'Medicated soap', '100g', 800, null, false, false, '/assets/products/bath-soap-6.jpg', 20),
  ('body-care-1', 'body-care', 'Body lotion', '400ml', 4500, 5200, true, false, '/assets/products/body-care-1.jpg', 21),
  ('body-care-2', 'body-care', 'Body butter', '250g', 5500, null, false, false, '/assets/products/body-care-2.jpg', 22),
  ('body-care-3', 'body-care', 'Roll-on deodorant', '50ml', 1800, null, false, false, '/assets/products/body-care-3.jpg', 23),
  ('body-care-4', 'body-care', 'Body spray', '150ml', 2600, null, false, false, '/assets/products/body-care-4.jpg', 24),
  ('body-care-5', 'body-care', 'Shaving cream', '200ml', 2200, null, false, false, '/assets/products/body-care-5.jpg', 25),
  ('body-care-6', 'body-care', 'Petroleum jelly', '250ml', 1900, null, false, false, '/assets/products/body-care-6.jpg', 26),
  ('cleaning-1', 'cleaning', 'Dishwashing liquid', '750ml', 1800, null, true, false, '/assets/products/cleaning-1.jpg', 27),
  ('cleaning-2', 'cleaning', 'Laundry detergent', '2kg', 4800, 5500, false, false, '/assets/products/cleaning-2.jpg', 28),
  ('cleaning-3', 'cleaning', 'Bleach', '1 litre', 1500, null, false, false, '/assets/products/cleaning-3.jpg', 29),
  ('cleaning-4', 'cleaning', 'Floor cleaner', '1 litre', 2400, null, false, false, '/assets/products/cleaning-4.jpg', 30),
  ('cleaning-5', 'cleaning', 'Toilet cleaner', '750ml', 1900, null, false, false, '/assets/products/cleaning-5.jpg', 31),
  ('cleaning-6', 'cleaning', 'Scouring sponges', '3 pieces', 900, null, false, false, '/assets/products/cleaning-6.jpg', 32),
  ('cleaning-7', 'cleaning', 'Fabric softener', '1 litre', 3200, null, false, false, '/assets/products/cleaning-7.jpg', 33),
  ('fragrance-1', 'fragrance', 'Eau de parfum for women', '100ml', 18000, null, false, false, '/assets/products/fragrance-1.jpg', 34),
  ('fragrance-2', 'fragrance', 'Eau de toilette for men', '100ml', 15500, null, false, false, '/assets/products/fragrance-2.jpg', 35),
  ('fragrance-3', 'fragrance', 'Body mist', '200ml', 5200, null, false, false, '/assets/products/fragrance-3.jpg', 36),
  ('fragrance-4', 'fragrance', 'Perfume oil', '10ml', 4500, null, false, false, '/assets/products/fragrance-4.jpg', 37),
  ('fragrance-5', 'fragrance', 'Room air freshener', '300ml', 2200, null, false, false, '/assets/products/fragrance-5.jpg', 38),
  ('fragrance-6', 'fragrance', 'Fragrance gift set', '3 pieces', 24000, null, false, true, '/assets/products/fragrance-6.jpg', 39),
  ('fruits-1', 'fruits', 'Apples', '1kg', 3500, 4000, false, false, '/assets/products/fruits-1.jpg', 40),
  ('fruits-2', 'fruits', 'Bananas', '1 bunch', 1500, null, true, false, '/assets/products/fruits-2.jpg', 41),
  ('fruits-3', 'fruits', 'Oranges', '1kg', 2000, null, false, false, '/assets/products/fruits-3.jpg', 42),
  ('fruits-4', 'fruits', 'Watermelon', '1 whole', 4000, null, false, false, '/assets/products/fruits-4.jpg', 43),
  ('fruits-5', 'fruits', 'Pineapple', '1 piece', 1800, null, false, false, '/assets/products/fruits-5.jpg', 44),
  ('fruits-6', 'fruits', 'Mangoes', '1kg', 2500, null, false, true, '/assets/products/fruits-6.jpg', 45),
  ('fruits-7', 'fruits', 'Grapes', '500g', 3800, null, false, false, '/assets/products/fruits-7.jpg', 46),
  ('groceries-1', 'groceries', 'Long grain rice', '10kg', 22000, 25300, true, false, '/assets/products/groceries-1.jpg', 47),
  ('groceries-2', 'groceries', 'Vegetable oil', '3 litres', 9500, 10900, false, false, '/assets/products/groceries-2.jpg', 48),
  ('groceries-3', 'groceries', 'Spaghetti', '500g', 1300, null, false, false, '/assets/products/groceries-3.jpg', 49),
  ('groceries-4', 'groceries', 'Sugar', '1kg', 1800, null, false, false, '/assets/products/groceries-4.jpg', 50),
  ('groceries-5', 'groceries', 'Tomato paste', '400g', 1200, null, false, false, '/assets/products/groceries-5.jpg', 51),
  ('groceries-6', 'groceries', 'Evaporated milk', '400g', 1700, null, false, false, '/assets/products/groceries-6.jpg', 52),
  ('groceries-7', 'groceries', 'Eggs', 'crate of 30', 5500, null, true, false, '/assets/products/groceries-7.jpg', 53),
  ('groceries-8', 'groceries', 'Bread', '1 loaf', 1500, null, false, false, '/assets/products/groceries-8.jpg', 54),
  ('hair-extension-1', 'hair-extension', 'Straight bundle hair', '20 inch', 45000, null, false, false, '/assets/products/hair-extension-1.jpg', 55),
  ('hair-extension-2', 'hair-extension', 'Curly weave', '18 inch', 38000, null, false, false, '/assets/products/hair-extension-3.jpg', 56),
  ('hair-extension-3', 'hair-extension', 'Braiding hair', 'pack', 3500, null, false, false, '/assets/products/hair-extension-3.jpg', 57),
  ('hair-extension-4', 'hair-extension', 'Lace closure', '4 x 4 inch', 25000, null, false, false, '/assets/products/hair-extension-4.jpg', 58),
  ('hair-extension-5', 'hair-extension', 'Hair clips', 'pack of 12', 1200, null, false, false, '/assets/products/hair-extension-5.jpg', 59),
  ('hair-extension-6', 'hair-extension', 'Wig cap', '1 piece', 1500, null, false, false, '/assets/products/hair-extension-6.jpg', 60),
  ('hair-care-1', 'hair-care', 'Shampoo', '400ml', 3800, 4400, false, false, '/assets/products/hair-care-1.jpg', 61),
  ('hair-care-2', 'hair-care', 'Conditioner', '400ml', 3900, null, false, false, '/assets/products/hair-care-2.jpg', 62),
  ('hair-care-3', 'hair-care', 'Hair growth oil', '200ml', 2800, null, false, false, '/assets/products/hair-care-3.jpg', 63),
  ('hair-care-4', 'hair-care', 'Hair relaxer kit', '1 kit', 4500, null, false, false, '/assets/products/hair-care-4.jpg', 64),
  ('hair-care-5', 'hair-care', 'Edge control', '100ml', 2200, null, false, false, '/assets/products/hair-care-5.jpg', 65),
  ('hair-care-6', 'hair-care', 'Detangling brush', '1 piece', 1800, null, false, false, '/assets/products/hair-care-6.jpg', 66),
  ('hair-care-7', 'hair-care', 'Satin bonnet', '1 piece', 2000, null, false, true, '/assets/products/hair-care-7.jpg', 67),
  ('non-alcoholic-1', 'non-alcoholic', 'Bottled water', '12 x 75cl', 3600, 4100, false, false, '/assets/products/non-alcoholic-1.jpg', 68),
  ('non-alcoholic-2', 'non-alcoholic', 'Orange juice', '1 litre', 2200, null, true, false, '/assets/products/non-alcoholic-2.jpg', 69),
  ('non-alcoholic-3', 'non-alcoholic', 'Malt drink', '6 x 33cl', 4800, null, false, false, '/assets/products/non-alcoholic-3.jpg', 70),
  ('non-alcoholic-4', 'non-alcoholic', 'Cola drink', '12 x 50cl', 5400, null, false, false, '/assets/products/non-alcoholic-4.jpg', 71),
  ('non-alcoholic-5', 'non-alcoholic', 'Energy drink', '33cl', 900, null, false, false, '/assets/products/non-alcoholic-5.jpg', 72),
  ('non-alcoholic-6', 'non-alcoholic', 'Tea bags', '100 bags', 2600, null, false, false, '/assets/products/non-alcoholic-6.jpg', 73),
  ('non-alcoholic-7', 'non-alcoholic', 'Chocolate drink powder', '400g', 4500, null, false, false, '/assets/products/non-alcoholic-7.jpg', 74),
  ('oral-care-1', 'oral-care', 'Toothpaste', '120g', 1500, null, true, false, '/assets/products/oral-care-1.jpg', 75),
  ('oral-care-2', 'oral-care', 'Soft toothbrush', '1 piece', 700, null, false, false, '/assets/products/oral-care-2.jpg', 76),
  ('oral-care-3', 'oral-care', 'Mouthwash', '500ml', 3200, null, false, false, '/assets/products/oral-care-3.jpg', 77),
  ('oral-care-4', 'oral-care', 'Dental floss', '50m', 1200, null, false, false, '/assets/products/oral-care-4.jpg', 78),
  ('oral-care-5', 'oral-care', 'Whitening toothpaste', '100g', 2400, null, false, false, '/assets/products/oral-care-5.jpg', 79),
  ('oral-care-6', 'oral-care', 'Electric toothbrush', '1 piece', 18000, null, false, true, '/assets/products/oral-care-6.jpg', 80),
  ('seasoning-1', 'seasoning', 'Seasoning cubes', '50 pieces', 2600, null, true, false, '/assets/products/seasoning-1.jpg', 81),
  ('seasoning-2', 'seasoning', 'Curry powder', '100g', 1000, null, false, false, '/assets/products/seasoning-2.jpg', 82),
  ('seasoning-3', 'seasoning', 'Thyme', '50g', 900, null, false, false, '/assets/products/seasoning-3.jpg', 83),
  ('seasoning-4', 'seasoning', 'Ground pepper', '200g', 1800, null, false, false, '/assets/products/seasoning-4.jpg', 84),
  ('seasoning-5', 'seasoning', 'Iodised salt', '1kg', 700, null, false, false, '/assets/products/seasoning-5.jpg', 85),
  ('seasoning-6', 'seasoning', 'Garlic powder', '100g', 1400, null, false, false, '/assets/products/seasoning-6.jpg', 86),
  ('seasoning-7', 'seasoning', 'Jollof spice mix', '100g', 1600, null, false, true, '/assets/products/seasoning-7.jpg', 87),
  ('skin-care-1', 'skin-care', 'Face wash', '150ml', 3200, 3700, false, false, '/assets/products/skin-care-1.jpg', 88),
  ('skin-care-2', 'skin-care', 'Moisturiser SPF 30', '50ml', 6500, null, false, false, '/assets/products/skin-care-2.jpg', 89),
  ('skin-care-3', 'skin-care', 'Sunscreen', '100ml', 5800, null, false, true, '/assets/products/skin-care-3.jpg', 90),
  ('skin-care-4', 'skin-care', 'Face serum', '30ml', 8500, null, true, false, '/assets/products/skin-care-4.jpg', 91),
  ('skin-care-5', 'skin-care', 'Facial toner', '200ml', 4200, null, false, false, '/assets/products/skin-care-5.jpg', 92),
  ('skin-care-6', 'skin-care', 'Lip balm', '1 piece', 1200, null, false, false, '/assets/products/skin-care-6.jpg', 93),
  ('skin-care-7', 'skin-care', 'Sheet face masks', '5 pieces', 4000, null, false, true, '/assets/products/skin-care-7.jpg', 94)
on conflict (id) do nothing;

-- ----------------------------------------------------------- security
-- All access goes through the Express API using the service-role key.
-- RLS on with no policies = the public anon/authenticated keys can read nothing.
alter table public.users                 enable row level security;
alter table public.errand_requests       enable row level security;
alter table public.errand_status_history enable row level security;

-- Private bucket for agent proof uploads.
insert into storage.buckets (id, name, public) values ('proofs', 'proofs', false), ('requests', 'requests', false)
on conflict (id) do nothing;

-- ======================================================= moving bookings (008)

-- ------------------------------------------------------------ rates (one row, edited in the admin dashboard)
create table if not exists public.moving_settings (
  id              int primary key default 1 check (id = 1),
  small_van_rate  numeric(12,2) not null default 4000 check (small_van_rate > 0 and small_van_rate <= 1000000),  -- naira per kilometre
  big_van_rate    numeric(12,2) not null default 8000 check (big_van_rate > 0 and big_van_rate <= 1000000),
  max_distance_km numeric(8,2)  not null default 1500 check (max_distance_km > 0),                              -- longer routes are refused as probable mistakes
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.users(id) on delete set null
);
insert into public.moving_settings (id) values (1) on conflict (id) do nothing;
alter table public.moving_settings enable row level security;

-- ------------------------------------------------------------ bookings
create table if not exists public.moving_bookings (
  id              uuid primary key default gen_random_uuid(),
  errand_id       text not null unique references public.errand_requests(errand_id) on delete cascade,
  idempotency_key text unique,                       -- stops a double click creating two bookings
  pickup_address  text not null,
  pickup_state    text, pickup_city text,
  pickup_lat      numeric(9,6), pickup_lng numeric(9,6),
  dest_address    text not null,
  dest_state      text, dest_city text,
  dest_lat        numeric(9,6), dest_lng numeric(9,6),
  distance_km     numeric(8,1) not null check (distance_km > 0),   -- one-way road distance, pickup to destination
  vehicle         text not null check (vehicle in ('small', 'big')),
  rate_per_km     numeric(12,2) not null check (rate_per_km > 0),  -- the rate used (kept even if the rate changes later)
  moving_fee      numeric(12,2) not null check (moving_fee > 0),   -- distance_km x rate_per_km
  total           numeric(12,2) not null check (total >= moving_fee),
  moving_date     date,
  pickup_time     text,
  property_type   text,
  items           text[] not null default '{}',
  notes           text,
  status          text not null default 'pending' check (status in ('pending', 'confirmed', 'assigned', 'in_progress', 'completed', 'cancelled')),
  routing_provider text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint moving_fee_matches check (moving_fee = round(distance_km * rate_per_km, 2))
);
create index if not exists moving_bookings_status_idx on public.moving_bookings (status);
create index if not exists moving_bookings_created_idx on public.moving_bookings (created_at desc);
alter table public.moving_bookings enable row level security;
do $$ begin
  create trigger moving_bookings_updated before update on public.moving_bookings
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

-- ===== moving receipt email (009)
alter table public.moving_bookings add column if not exists receipt_sent_at timestamptz;
