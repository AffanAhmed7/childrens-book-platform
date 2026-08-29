# Cart, Payments & Print Dispatch — setup checklist

Everything in this doc is a manual account/dashboard step, not code. Follow
it in order; each section says exactly what env var(s) it produces.

Spec: [docs/superpowers/specs/2026-08-30-cart-payments-print-dispatch-design.md](superpowers/specs/2026-08-30-cart-payments-print-dispatch-design.md)

## Status — 2026-08-30, live-verified against real test-mode infra

- **Stripe: fully verified end to end.** Real PaymentIntent created by
  `POST /api/checkout`, real Payment Element mounted, payment confirmed via
  Stripe's test card token, webhook delivered and signature-verified, order
  correctly transitioned `awaiting_payment → paid` with a full audit trail.
- **Resend: verified.** `sendOrderConfirmationEmail` sent a real email via
  the account's sandbox sender (`onboarding@resend.dev`) — works today, no
  domain verification needed yet, but only delivers to the account's own
  email until one is added (see §3).
- **Gelato: request shape verified, no order actually placed.**
  `assembleItemPdf` → `submitOrderToGelato` reached Gelato's live order API
  and got a clean `400 BAD_REQUEST — "complete the company information in
  the portal"` — i.e. auth and request shape are correct, but the account
  needs billing/company info added before it will accept any order (see §2
  for the real product UID this was tested against, and the page-count issue
  it surfaced).
- **Found and fixed separately:** the Upstash Redis instance referenced in
  `.env` had stopped resolving in DNS entirely (likely reclaimed for
  inactivity) — this blocked the *entire* existing render pipeline, not
  anything new. A fresh Upstash instance is now wired in and confirmed
  working. **Known residual gap:** if Redis becomes *completely* unreachable
  again (not just slow), `runFulfillment`'s render-enqueue call was observed
  retrying indefinitely instead of failing the order — worth a bounded
  timeout if this keeps happening in production, not yet fixed.

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

**Update:** the request shape in `apps/api/src/print/gelato.ts` (URL, auth
header, field names) is now confirmed correct — verified live against
Gelato's real order-create API, which returned a clean business-rule
rejection rather than an auth/schema error (see status section above). Two
real things surfaced that still need your decision, not code fixes:

1. **A real, working product UID is already wired into `apps/api/.env`:**
   ```
   GELATO_PRODUCT_UID=photobooks-hardcover_pf_200x200-mm-8x8-inch_pt_170-gsm-65lb-coated-silk_cl_4-4_ccl_4-4_bt_glued-left_ct_matt-lamination_prt_1-0_cpt_130-gsm-65-lb-cover-coated-silk_ver
   ```
   An 8×8in hardcover photobook, confirmed via Gelato's Product Catalog API
   (`product.gelatoapis.com/v3/products/{uid}`) to have **zero unsupported
   countries**. **Watch out:** a near-identical UID exists with the trim-size
   segment reordered (`8x8-inch-200x200-mm` instead of
   `200x200-mm-8x8-inch`) that looks identical but excludes 238 countries
   including France, the US, and the UK — always check `notSupportedCountries`
   on the *product detail* endpoint (the catalog *search* endpoint doesn't
   populate this field reliably) before trusting a UID.
2. **This product needs a minimum of 28 pages** (steps of 2, up to 200).
   `apps/api/src/pipeline/catalog.ts`'s current book configs (`demo-book`: 3
   pages, `demo-book-duo`: 2 pages) are demo/prototype content — real
   sellable books need either 28+ pages of actual illustrated content, or a
   different Gelato product with a lower minimum (worth checking other
   catalogs — `soft-cover-photobooks` has the same 28-page floor, but
   smaller formats like `cards` or `folded-cards` might not). This is a
   content/business decision, not something to guess at in code.
3. `PRINT_TRIM_WIDTH_IN`/`PRINT_TRIM_HEIGHT_IN` in `.env` are already set to
   `8`/`8` to match this product's real 203.2mm (~8in) page size.
4. **Before any order will actually go through:** Gelato's dashboard needs
   company/billing information completed (Settings → Company/Billing in
   their dashboard) — that's the exact thing the test rejection asked for.
5. If Gelato's dashboard offers a webhook signing secret for order-status
   callbacks, put it in `apps/api/.env`'s `GELATO_WEBHOOK_SECRET` and confirm
   `apps/api/src/orderStatus.ts`'s `mapGelatoStatus` covers every status
   string their webhook actually sends (extend the map if not — it currently
   covers `created`, `in_production`, `printed`, `shipped`, `delivered`,
   `cancelled`, `failed` as a best guess, still unverified against a real
   webhook delivery).
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
   domain (e.g. `orders@yourdomain.com`). **Until you add one**,
   `RESEND_FROM_ADDRESS=onboarding@resend.dev` (Resend's own sandbox sender)
   works with zero setup — confirmed live, a real email delivered
   successfully — but only to the account's own signup email, not customers.
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
RESEND_FROM_ADDRESS=orders@yourdomain.com   # or onboarding@resend.dev for now
PRINT_TRIM_WIDTH_IN=8            # matches the wired-in Gelato product
PRINT_TRIM_HEIGHT_IN=8
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
