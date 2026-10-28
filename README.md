# Detty Dezemba — transparent festival ticket spin

A mobile-first React + Express website for a limited Detty Dezemba Festival ticket drop. The campaign offers **exactly 1 Regular Festival ticket, 1 VIP ticket, 4 Free Spins and 114 No-Win positions across a fixed pool of 120 positions**, at **KES 500 per paid entry**. Starting odds are **1 in 120 for each ticket type**, **1 in 60 for any ticket**, and **1 in 20 for any reward**, with **exactly 95% No Win**. The visual treatment uses the event's black, off-white and gold identity with original photos from dettydezemba.com.

## Run it

```bash
npm install
npm run dev
```

The app binds to `0.0.0.0:3000`. The default mode is `PAYMENTS_MODE=demo`: Paystack M-Pesa approval is simulated, no phone is charged, and the ledger starts with clearly demonstrative test entries.

```bash
npm test          # fairness, payment-order and receipt tests
npm run typecheck # TypeScript checks for shadcn components
npm run build     # production frontend build
npm start         # serve the API and built frontend on PORT (default 3000)
```

## Experience included

- Paystack M-Pesa phone checkout with Kenyan number validation, server-side transaction verification, and signed webhooks
- Server-confirmed payment state; the browser cannot mark an entry paid
- Original-style seven-slot wheel with Regular Ticket, Free Spin and VIP Ticket separated by four distributed No Win slots
- Ready-to-spin hub pulse, segment-synchronised pointer ticks, dramatic slowdown, and reduced-motion support
- Gold win flash, confetti, and a branded festival-ticket card with the winning receipt
- Exactly one Regular ticket, one VIP ticket, four Free Spins, current unallocated pool, and starting odds
- KES 0 Free Spin bonus entries with their own receipts and hash-chained results; bonus entries do not count toward the three paid entries per phone
- Hash-chained result receipts with masked entrant data available from the fairness API
- Locally verifiable SHA-256 result receipts
- Downloadable receipts, commitment record, and post-close pool reveal
- Phone-first spin layout with a stacked event headline, safe-area padding, large touch targets, and bottom-sheet dialogs
- Compact payment, result, and fairness dialogs

## Spin-focused UI and shadcn structure

The homepage is intentionally reduced to the spinning experience: the wheel, Paystack M-Pesa entry, ticket/entry counts, progress, and the entrant's own result reveal. Fairness opens in a compact dialog; there is no public Results screen. The optional `GlowCard` and step demo remain available but are not rendered in the spin-only interface.

Project paths:

- `/components/ui/spotlight-card.tsx` — optional reusable spotlight/glow primitive
- `/components/demo.tsx` — optional three-step demo, not rendered in the spin-only UI
- `/lib/utils.ts` — shadcn `cn` utility
- `/src/styles.css` — shared styles and Tailwind entry
- `/src/spin-only.css` — focused spinner layout and compact results dialog
- `/components.json` — shadcn CLI configuration
- `/tailwind.config.js` — Tailwind content and theme configuration
- `/tsconfig.json` — TypeScript configuration with `@/*` project-root aliases

Keeping reusable primitives in **`/components/ui`** matters because shadcn CLI generates and updates components there. It also separates design-system primitives from application-specific sections and keeps imports consistent.

To reproduce the setup in another Vite project, install TypeScript and Tailwind, configure the `@` alias, then run:

```bash
npx shadcn@latest init
npm install clsx tailwind-merge lucide-react
```

The spotlight component itself needs no image assets, context providers, or additional runtime packages.

## Fairness model

1. The server creates exactly one `win` (Regular), one `vip-win` (VIP), four `free-spin`, and 114 `no-win` outcomes. A Free Spin is never placed in the final pool position, so every Free Spin has a following position available.
2. A Fisher–Yates shuffle uses Node's `crypto.randomInt`, and a random 256-bit salt is generated.
3. Before demo entries are created or live entries are accepted, the app publishes `SHA-256(JSON.stringify(poolPayload))` as the commitment. The pool payload uses schema `tiketi.pool.v5` and includes the Regular/VIP ticket and Free Spin counts.
4. Successful payments receive the next outcome in payment-confirmation order. The outcome is concealed from the player API until the spin is revealed.
5. A revealed Free Spin creates one KES 0 bonus entry consuming the next concealed pool position. Bonus entries can chain, do not count toward the three paid entries per phone, and receive their own `DD-` receipt.
6. Spin calls are idempotent: an entry can reveal only one result, and retrying returns the original receipt. Repeating a Free Spin reveal does not create a duplicate bonus entry.
7. Each completed result, including a bonus result, contains the previous result hash. Any edited historical result breaks the subsequent chain.
8. Once the drop closes and all allocated entries have revealed, the original pool and salt become available at `/api/campaign/reveal` for independent commitment verification. Incompatible saved pools use an explicit schema check; simulated data is archived before a fresh pool is created, while live-mode data is never automatically reset.

The wheel preserves the original multi-slot presentation with **seven illustrated slots**: Regular Ticket, two No Win, Free Spin, No Win, VIP Ticket, and No Win. This distributes the No-Win positions around the wheel instead of grouping them together. Slot size is illustrative rather than a probability map; the committed 120-position pool determines the server-issued outcome. Starting odds are **1 in 120 for each ticket type**, **1 in 60 for any ticket**, and **1 in 20 for any reward**, with **exactly 95% No Win**, and remaining odds change as pool positions are allocated.

## Deploy to Vercel (hosted demo)

The `api/index.js` function and `/api/*` rewrite adapt the Express API for Vercel, while Vite publishes the frontend from `dist`:

```bash
npx vercel link
npx vercel deploy --prod
```

When `DATABASE_URL` or `POSTGRES_URL` is present, the app stores the campaign in Postgres. Every payment allocation and spin runs in a transaction with `SELECT ... FOR UPDATE`, so separate Vercel instances cannot allocate the same pool position. Demo and live campaigns use separate rows, which keeps simulated entries out of the live campaign and gives live mode a fresh commitment on first use. Without a database URL, local development uses the JSON store and Vercel demo mode falls back to ephemeral storage; Vercel live mode refuses to start without Postgres.

## Paystack M-Pesa integration

The server includes a Paystack [Charge API](https://paystack.com/docs/api/charge/) integration for Kenyan M-Pesa. Demo mode never calls Paystack and never charges a phone. Live mode collects the customer's email and M-Pesa number, sends **KES 500 as 50,000 currency subunits**, and attaches a unique entry reference and metadata to the charge.

For a properly hosted live environment, copy `.env.example` to `.env` and configure:

```dotenv
PAYMENTS_MODE=live
DATABASE_URL=postgresql://...
PAYSTACK_SECRET_KEY=sk_live_...
```

Live mode deliberately requires an `sk_live_` secret; a test key cannot unlock a live entry. Never expose the secret to the React app or commit it to git. Configure this public HTTPS webhook in the Paystack dashboard:

```text
POST /api/payments/paystack/webhook
```

The webhook follows Paystack's [signed-webhook guidance](https://paystack.com/docs/payments/webhooks/): the raw request body is checked with HMAC-SHA512 before processing. Both webhook confirmation and throttled status checks independently call Paystack's transaction verification API. A spin unlocks only after the server confirms a live, successful mobile-money transaction with the exact entry reference, metadata, KES currency, and **50,000-subunit** amount. Mismatches go to manual review rather than receiving an entry.

Demo mode is the default and never calls Paystack. Live activation requires both persistent Postgres storage and a live server key; Vercel live mode still refuses to start if Postgres is missing. The local JSON mode is suitable only for a conventional single-process Node host, not a multi-instance live deployment. The website never asks for an M-Pesa PIN; customers enter it only in the phone's official prompt.

## Important before a real launch

This is a functional reference implementation, not a claim of legal or production certification.

- Paid chance-based prize promotions in Kenya may require **Betting Control and Licensing Board (BCLB)** authorisation and other approvals. Obtain qualified Kenyan legal advice and all required approvals before accepting money.
- The included Postgres store uses row-level locks for atomic payment/entry allocation. Before a real launch, add scheduled payment reconciliation, refund handling, monitoring, backups, durable rate limiting, and queue-based webhook processing.
- Complete an independent security review and fairness audit. Commitments and hash chains make changes detectable; they do not prove the operator's infrastructure is secure or legally compliant.
- Publish operator identity, final event/prize details, eligibility, claim deadlines, cancellation/refund rules, a Kenya Data Protection Act-compliant privacy notice, and responsible-participation controls.
- Keep demo entries out of the live campaign and protect the outcome pool and salt in the secured Postgres store. Demo and live rows are separate by default.
- Verify Paystack M-Pesa charge, webhook, and transaction-verification behaviour against Paystack's current documentation and your account's Kenya mobile-money enablement.

## Main files

- `src/App.jsx` — page, entry flow, wheel interaction, and entrant result reveal
- `src/Modals.jsx` — checkout, result, verification, and policy dialogs
- `src/Wheel.jsx` — responsive SVG wheel animation
- `src/styles.css` — full responsive visual system
- `server/campaign.js` — committed pool, payment ordering, receipts, and public projections
- `server/paystack.js` — server-only Paystack charge, verification, and webhook-signature integration
- `server/index.js` — API, Paystack webhook handling, and app server
- `server/store.js` — Postgres persistence with row-level locking, plus the local JSON fallback
- `server/campaign.test.js` — core fairness and integrity tests
- `server/paystack.test.js` — mocked Paystack request, validation, and signature tests
- `server/store.test.js` — storage rollback, persistence, and allocation tests
