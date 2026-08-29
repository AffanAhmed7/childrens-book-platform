# Cart, Payments & Print Dispatch — setup checklist

Everything in this doc is a manual account/dashboard step, not code. The code
(`apps/api`'s checkout/webhook/fulfillment routes, `apps/web`'s cart/checkout/
confirmation/track pages) is built and typechecked, but three external
integrations — Stripe, Gelato, Resend — cannot be exercised live until you
complete the setup below. Follow it in order; each section says exactly what
env var(s) it produces.

Spec: [docs/superpowers/specs/2026-08-30-cart-payments-print-dispatch-design.md](superpowers/specs/2026-08-30-cart-payments-print-dispatch-design.md)

## 1. Stripe

1. Create a Stripe account at https://dashboard.stripe.com/register if you
   don't have one.
2. Stay in **Test mode** (toggle top-right of the dashboard) for everything
   below until you're ready to actually charge real cards.
3. Go to **Developers → API keys**. Copy:
   - **Secret key** (`sk_test_...`) → `apps/api/.env`'s `STRIPE_SECRET_KEY`
   - **Publishable key** (`pk_test_...`) → `apps/web/.env.local`'s
     `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
4. Install the Stripe CLI (https://docs.stripe.com/stripe-cli) for local
   webhook testing:
   ```bash
   stripe login
   stripe listen --forward-to localhost:3001/api/webhooks/stripe
   ```
   The CLI prints a webhook signing secret (`whsec_...`) — put that in
   `apps/api/.env`'s `STRIPE_WEBHOOK_SECRET`. This secret is **local-CLI-only**
   and different from the one you'll get in step 6 for a real deployment.
5. Test the flow with Stripe's test card `4242 4242 4242 4242`, any future
   expiry date, any 3-digit CVC, any postal code. Full list of test cards
   (including ones that simulate declines) at
   https://docs.stripe.com/testing.
6. **Before going live** (real deployment, real charges):
   - Switch to **Live mode**, get the live `sk_live_...`/`pk_live_...` keys.
   - In **Developers → Webhooks**, add an endpoint pointing at your deployed
     API's `/api/webhooks/stripe` URL, subscribed to at least
     `payment_intent.succeeded`. This gives you a **new**, production
     `whsec_...` — use that in your deployed environment, not the CLI one.
   - Stripe requires a real business profile (legal name, address, bank
     account for payouts) before Live mode accepts real charges — fill that
     in under **Settings → Business settings**.

## 2. Gelato (print-on-demand dispatch)

**Caveat up front:** the code in `apps/api/src/print/gelato.ts` was written
from Gelato's commonly-documented v4 Order API shape, without a real account
to verify against — the URL, field names, and response shape are a strong
starting point, not a confirmed contract. Budget time to diff the real API
against that file once you're through step 3 below.

1. Create a Gelato account at https://www.gelato.com (their API product is
   under "Gelato API" / "Print API" in their developer offering).
2. Once approved, find your **API key** in the Gelato dashboard under API/
   developer settings → `apps/api/.env`'s `GELATO_API_KEY`.
3. Browse Gelato's product catalog (https://dashboard.gelato.com or their API
   docs at https://docs.gelato.com) and pick a physical product that matches
   what you want to sell — a hardcover or softcover kids' photo book. Note:
   - Its **product UID** → `apps/api/.env`'s `GELATO_PRODUCT_UID`
   - Its **exact trim size** (width × height in inches) → update
     `PRINT_TRIM_WIDTH_IN` / `PRINT_TRIM_HEIGHT_IN` in `apps/api/.env` to
     match. The code defaults to 8.5×8.5in, which is almost certainly not
     what the real product uses.
   - Its **minimum/fixed page count** — the current book configs in
     `apps/api/src/pipeline/catalog.ts` (`demo-book`: 3 pages, `demo-book-duo`:
     2 pages) may need to change to match what the product requires.
4. Place one real test order through Gelato's own dashboard or API docs
   directly (not through this app) to see the actual request/response shape,
   then compare it against `submitOrderToGelato` in
   `apps/api/src/print/gelato.ts` and adjust field names if they differ.
5. If Gelato's dashboard offers a webhook signing secret for order-status
   callbacks, put it in `apps/api/.env`'s `GELATO_WEBHOOK_SECRET` and confirm
   `apps/api/src/orderStatus.ts`'s `mapGelatoStatus` covers every status
   string their webhook actually sends (extend the map if not — it currently
   covers `created`, `in_production`, `printed`, `shipped`, `delivered`,
   `cancelled`, `failed` as a best guess).
6. Configure the webhook callback URL in Gelato's dashboard to point at your
   deployed API's `/api/webhooks/gelato`.

## 3. Resend (order confirmation email)

1. Create a Resend account at https://resend.com/signup.
2. **Add and verify a sending domain**: Dashboard → Domains → Add Domain,
   then add the DNS records (SPF/DKIM) it gives you at your domain registrar.
   This can take a few minutes to a few hours to verify. Without a verified
   domain, Resend only lets you send to your own account's email address —
   fine for testing, not for real customers.
3. Once verified, go to **API Keys** → create one → put it in `apps/api/.env`'s
   `RESEND_API_KEY`.
4. Set `apps/api/.env`'s `RESEND_FROM_ADDRESS` to an address at your verified
   domain (e.g. `orders@yourdomain.com`).
5. Send yourself a real test order (see the walkthrough below) and confirm
   the email arrives and isn't in spam — if it lands in spam, check your
   domain's DKIM/SPF/DMARC setup in Resend's domain verification page.

## 4. Wiring it together — env files

`apps/api/.env` needs (see `apps/api/.env.example` for the full list, this is
just the new section):
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
GELATO_API_KEY=...
GELATO_PRODUCT_UID=...
GELATO_WEBHOOK_SECRET=...        # optional, only if Gelato offers one
RESEND_API_KEY=re_...
RESEND_FROM_ADDRESS=orders@yourdomain.com
PRINT_TRIM_WIDTH_IN=8.5          # match your real Gelato product
PRINT_TRIM_HEIGHT_IN=8.5
```

`apps/web/.env.local` (copy from `.env.local.example`) needs:
```
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001    # or your deployed API URL
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

## 5. Full local walkthrough, once the above is done

```bash
# terminal 1
cd apps/api && npm run dev

# terminal 2
cd apps/api && stripe listen --forward-to localhost:3001/api/webhooks/stripe

# terminal 3
cd apps/web && npm run dev

# terminal 4 — optional, only needed if you want to start from a real
# personalized preview rather than an existing session id
cd apps/api && npm run homepage
```

1. Personalize a book via the homepage (`http://127.0.0.1:5174`) — this
   costs one real Replicate render, budget accordingly.
2. Click "Add this book to cart" once it finishes.
3. On `/cart` (`http://localhost:3000/cart`), confirm the book and price,
   click "Proceed to checkout".
4. Fill the address form, check GDPR consent, pay with the Stripe test card.
5. Confirm you land on `/confirmation` with the right receipt.
6. Watch the `apps/api` terminal: it should enqueue a full-book render, then
   assemble a PDF, then call Gelato (expect this to fail until steps 2-4
   above are fully correct — that's expected, not a bug, and should show up
   as a `failed` status with a clear message on `/track/[orderId]`, not a
   silent hang), then send the Resend email if it gets that far.
7. Click "Track your order" and confirm the status timeline reflects what
   actually happened.

## 6. Deploying (out of scope for this checklist, flagged for later)

`apps/api` and `apps/web` both need public hosting before the Stripe/Gelato
webhook URLs above can point anywhere but `localhost`. Per prior project
notes, Railway/Render are reasonable options for `apps/api` (it already has
real Neon/Upstash/R2 credentials); `apps/web` is a standard Next.js app and
deploys cleanly to Vercel or similar. Not detailed further here — a separate
task once you're ready for it.
