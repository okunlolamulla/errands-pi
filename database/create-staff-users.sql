-- Gives your admin and agent logins their role. Run in the Supabase SQL Editor AFTER supabase-setup.sql.
--
-- 1) Supabase dashboard > Authentication > Users > Add user (tick "Auto confirm user").
--    The user's UUID is shown in the list: copy it.
-- 2) Replace the placeholders below (UUID, name, email, phone) and run.
--    The email must be the same one you used for the login.

-- Admin
insert into public.users (id, name, email, phone, role)
values ('PASTE-ADMIN-UUID', 'Your Name', 'you@example.com', '08012345678', 'admin');

-- Agent (repeat for each agent)
insert into public.users (id, name, email, phone, role)
values ('PASTE-AGENT-UUID', 'Agent Name', 'agent@example.com', '08087654321', 'agent');

-- Hide an agent from the "assign" dropdown (and bring them back):
--   update public.users set is_active = false where email = 'agent@example.com';
--   update public.users set is_active = true  where email = 'agent@example.com';
