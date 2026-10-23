// Creates the first admin login so you can open the dashboard straight away.
//   npm run create-admin            (run inside admin/api, after .env has your Supabase keys)
//   npm run create-admin -- --reset (puts the default password back if you are locked out)
//
// Default login (change it at first sign-in: the dashboard makes you):
//   Email:    admin@errandboys.com
//   Password: ErrandBoys@2026
// To use your own email instead, set ADMIN_EMAIL (and optionally ADMIN_PASSWORD, ADMIN_NAME) first.
import 'dotenv/config';
import { supabase } from '../src/config/supabase.js';

const email = (process.env.ADMIN_EMAIL || 'admin@errandboys.com').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || 'ErrandBoys@2026';
const name = process.env.ADMIN_NAME || 'Errand Boys Admin';
const reset = process.argv.includes('--reset');

async function findUser() {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email || '').toLowerCase() === email);
    if (hit || data.users.length < 200) return hit;
  }
}

let user = await findUser();
if (user && !reset) {
  console.log(`An account for ${email} already exists. Nothing changed.\nIf you are locked out, run:  npm run create-admin -- --reset`);
  process.exit(0);
}
if (user) {
  const { error } = await supabase.auth.admin.updateUserById(user.id, { password, email_confirm: true });
  if (error) throw error;
} else {
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  user = data.user;
}
const { error } = await supabase.from('users').upsert(
  { id: user.id, name, email, role: 'admin', is_active: true, must_change_password: true }, { onConflict: 'id' });
if (error) throw error;

console.log(`
Admin login ready.
  Email:    ${email}
  Password: ${password}
You will be asked to choose a new password the first time you sign in.`);
