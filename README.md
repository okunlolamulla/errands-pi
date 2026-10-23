# Errand Boys API (launch phase)

Node.js + Express + Supabase PostgreSQL. Pairs with the React admin dashboard in `../../web/src/admin`.

## Setup
Follow `../../README.md` (database script: `../database/supabase-setup.sql`, server files: `../deploy/`).
For local development copy `.env.example` to `.env`, run `npm install`, then `npm run dev` (port 4000).

## Money flow
```
Admin saves quote -> API creates a checkout link with the gateway, stores it in `payments` (pending),
                     and sends it to the customer (email / WhatsApp)
Customer pays     -> gateway calls  POST /api/webhooks/payment
Webhook           -> 1. verify the signature            (401 if fake)
                     2. confirm_payment() in Postgres   Quoted -> Paid, atomically
                     3. reply 200 immediately
                     4. notify the customer (receipt) and the admin ("assign an agent")
Admin assigns     -> agent gets the job details, customer gets the agent's name
```
`confirm_payment()` (in the SQL) runs in one transaction. It makes the webhook safe against: the same webhook arriving twice
(`already_processed`), a wrong amount or currency (`mismatch`), and a payment for an old quote after you re-quoted
(`stale`). Mismatch and stale payments are NOT applied: they appear as a warning in the dashboard and by email so a person
can refund or fix them. The checkout reference is random and unique per quote.

### Who is notified, and when
No agent is assigned at the moment payment arrives (the admin assigns after payment), so:
- **Payment confirmed:** the customer gets a receipt; the admin gets "paid, assign an agent".
- **Agent assigned:** the agent gets the job (task, locations, time, customer contact); the customer gets the agent's name.

To pick agents before payment, add a "tentative agent" step to the quote flow.

## Choosing a gateway
Set `PAYMENT_PROVIDER` in `.env`. One is active at a time.
- **paystack** (default): `PAYSTACK_SECRET_KEY`. USD works only if Paystack enabled it for your account.
  In Paystack: Settings > API Keys & Webhooks > webhook URL = `https://YOUR-PUBLIC-URL/api/webhooks/payment`.
- **flutterwave**: `FLW_SECRET_KEY`, `FLW_REDIRECT_URL`, and `FLW_SECRET_HASH` (a password you invent; type the same one into
  Flutterwave's webhook settings, with the same URL). The API double-checks each payment with Flutterwave before accepting it.
- **mock**: development only (disabled when `NODE_ENV=production`). No account needed.
Stripe is not included: it generally isn't available to businesses registered in Nigeria.
The adapters are in `src/services/payments/`. Adding another gateway means one new file with `createCheckout` and `parseWebhook`.

## Test the whole flow on your computer (no gateway account)
1. `PAYMENT_PROVIDER=mock` in `.env`. Start the API and the dashboard.
2. Create a test errand (see the curl in "Endpoints"), then in the dashboard: **Send quote**.
3. Open the errand (View). Under **Payments** copy the reference (like `EB-K7M2QX-1a2b3c4d`).
4. "Pay" it: `node --env-file=.env scripts/simulate-payment.js EB-K7M2QX-1a2b3c4d 7500 NGN`
   It should print `200 accepted`. Refresh the dashboard: the errand is **Paid**.
5. Run the same command again: still 200, nothing changes (duplicates are safe). Try a wrong amount on a new quote: you get a
   payment-review warning instead of Paid.
6. Assign an agent. Without email/WhatsApp keys, the dashboard shows each notification as not configured.
For a real gateway, webhooks need a public HTTPS address: deploy the API, or use a tunnel such as `ngrok http 4000` while testing.

## Notifications setup
- **Email:** Resend account, verified domain, `RESEND_API_KEY`, `EMAIL_FROM`; `ADMIN_ALERT_EMAIL` for staff alerts.
- **WhatsApp:** each message type needs its own approved template (category Utility). Suggested wording:
  - QUOTE: `Hello {{1}}, your Errand Boys quote for {{2}} is {{3}}. Pay securely here: {{4}}`
  - PAID: `Hello {{1}}, we received your payment for {{2}}: {{3}}. We are assigning an agent now.`
  - ASSIGNED_CUSTOMER: `Hello {{1}}, {{3}} will handle your errand {{2}}. We will keep you updated.`
  - ASSIGNED_AGENT: `Hello {{1}}, you have a new errand {{2}} ({{3}}). Details: {{4}}`
  Put each template's name in the matching `WHATSAPP_TEMPLATE_*` variable.
- A failed message never undoes a quote, payment or assignment. Results are shown in the dashboard and logged by the server.

## Status flow
Pending Review -> Quoted -> Paid -> Assigned -> **On the way** -> In Progress -> Proof Uploaded -> Completed -> Closed

Agents tap **On the way**, **In progress**, **Completed**. Their "Completed" button needs proof and sets **Proof Uploaded**; an admin then
confirms it (**Completed**) and closes it. Agents may skip a step forward but never go back.

## Endpoints
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/errands` | Public | Submit a request -> `{errand_id, status, photos_saved}`. JSON, or `multipart/form-data` with up to 5 image `photos`; `contact_info` and `details` are sent as JSON text. `details` holds the service form answers (grocery: shopping_list, brands, budget, supermarket, landmark, instructions; moving: move_type, pickup_floor, destination_floor, packing_help, special_handling) |
| GET | `/api/errands/track/:errand_id` | Public | status, service, agent first name; while Quoted also `quote` and `payment_url`; never names/phones/addresses |
| POST | `/api/auth/login` | Public | `{email, password}` |
| **POST** | **`/api/webhooks/payment`** | Gateway | Signed by the gateway. `/api/webhooks/paystack` still works as an alias |
| GET | `/api/admin/errands`, `/api/admin/errands/:id`, `/api/admin/agents` | Admin | list / detail (with payments, history, proof links) / agents |
| GET | `/api/admin/payments/issues` | Admin | stale / mismatch payments needing review |
| PUT | `/api/admin/payments/:id/resolve` | Admin | mark one reviewed |
| PUT | `/api/admin/errands/:id/quote` | Admin | `{quote_amount, currency, notify}` -> `{errand, payment_link, notifications}` |
| PUT | `/api/admin/errands/:id/payment` | Admin | `{payment_reference}` manual "mark paid" (cash / transfer) |
| PUT | `/api/admin/errands/:id/assign` | Admin | `{agent_id}` -> `{errand, notifications}` |
| PUT | `/api/admin/errands/:id/complete`, `/close` | Admin | approve proof / close |
| GET | `/api/agent/errands` | Agent | the logged-in agent's jobs (no prices or emails) |
| PUT | `/api/agent/errands/:id/status` | Agent | `status` = On the way / In Progress / Proof Uploaded; multipart with `proof_notes`, `proof` files for Proof Uploaded |

```bash
curl -X POST http://localhost:4000/api/errands -H "Content-Type: application/json" -d "{\"service_type\":\"Grocery shopping\",\"task_description\":\"Buy items on my list\",\"contact_info\":{\"name\":\"Test\",\"phone\":\"08012345678\"}}"
```

## Design notes
- Errand IDs are `EB-` plus 6 random characters (database-generated, unique). Random on purpose: the track endpoint is public.
- Every status change goes through one function with compare-and-set; database CHECK constraints back it up.
- RLS is on with no policies, so Supabase's public keys read nothing. `confirm_payment` is callable only with the service-role key.
- Proof files are in a private bucket, shown to admins through 1-hour links.

## Not included yet
- An agent dashboard, a create-errand form for admins, refund automation, tests.
- Stripe. Retrying failed notifications automatically (re-quote re-sends the link; others are logged).
- **Never run against live accounts.** Syntax-checked only: the SQL has not been run in Postgres and none of the gateways,
  email or WhatsApp have been called. Test each step (the mock flow first) before real customers.
