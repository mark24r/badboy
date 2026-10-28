# Detty Dezemba — transparent festival ticket spin

A mobile-first React + Express website for a limited Detty Dezemba Festival ticket drop. The demo campaign offers **5 festival tickets across a fixed pool of 25 entries**, at **KES 500 per entry**, for **1 in 5 starting odds**. The visual treatment uses the event's black, off-white and gold identity with original photos from dettydezemba.com.

## Run it

```bash
npm install
npm run dev
```

The app binds to `0.0.0.0:3000`. The default mode is `PAYMENTS_MODE=demo`: STK Push approval is simulated, no phone is charged, and the ledger starts with clearly demonstrative test entries.

```bash
npm test          # fairness, payment-order and receipt tests
npm run typecheck # TypeScript checks for shadcn components
npm run build     # production frontend build
npm start         # serve the API and built frontend on PORT (default 3000)
```

## Experience included

- M-Pesa phone checkout with Kenyan number validation
- Server-confirmed payment state; the browser cannot mark an entry paid
- Ready-to-spin hub pulse, segment-synchronised pointer ticks, dramatic slowdown, and reduced-motion support
- Gold win flash, confetti, and a branded festival-ticket card with the winning receipt
- Fixed ticket and entry counts, current unallocated pool, and starting odds
- Hash-chained result receipts with masked entrant data available from the fairness API
- Locally verifiable SHA-256 result receipts
- Downloadable receipts, commitment record, and post-close pool reveal
- Phone-first spin layout with a stacked event headline, safe-area padding, large touch targets, and bottom-sheet dialogs
- Compact payment, result, and fairness dialogs

## Spin-focused UI and shadcn structure

The homepage is intentionally reduced to the spinning experience: the wheel, M-Pesa entry, ticket/entry counts, progress, and the entrant's own result reveal. Fairness opens in a compact dialog; there is no public Results screen. The optional `GlowCard` and step demo remain available but are not rendered in the spin-only interface.

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

1. The server creates exactly five `win` outcomes and 20 `no-win` outcomes.
2. A Fisher–Yates shuffle uses Node's `crypto.randomInt`, and a random 256-bit salt is generated.
3. Before demo entries are created or live entries are accepted, the app publishes `SHA-256(JSON.stringify(poolPayload))` as the commitment.
4. Successful payments receive the next outcome in payment-confirmation order. The outcome is concealed from the player API until the spin is revealed.
5. Spin calls are idempotent: a paid entry can reveal only one result, and retrying returns the original receipt.
6. Each completed result contains the previous result hash. Any edited historical result breaks the subsequent chain.
7. Once the drop closes and all paid entries have revealed, the original pool and salt become available at `/api/campaign/reveal` for independent commitment verification.

The wheel's five equal segments illustrate the **1 in 5 starting odds**. They do not determine the outcome; the remaining odds change as positions in the fixed pool are allocated.

## Deploy to Vercel (hosted demo)

The `api/index.js` function and `/api/*` rewrite adapt the Express API for Vercel, while Vite publishes the frontend from `dist`:

```bash
npx vercel link
npx vercel deploy --prod
```

Vercel's filesystem is ephemeral, so the hosted demo stores its campaign in that function instance's temporary storage. Entries and results can reset between instances or deployments; this is suitable for a product demonstration, not a shared production campaign. The Vercel adapter refuses `PAYMENTS_MODE=live`. Use a conventional Node host for the existing local JSON mode, or replace the store with a production database and atomic transactions before enabling real payments.

## Enable Safaricom Daraja

Copy `.env.example` to `.env` and configure:

```dotenv
PAYMENTS_MODE=live
MPESA_ENV=sandbox # change to production only after approval and testing
MPESA_CONSUMER_KEY=...
MPESA_CONSUMER_SECRET=...
MPESA_SHORTCODE=...
MPESA_PASSKEY=...
MPESA_CALLBACK_URL=https://your-public-domain.example/api/payments/callback
MPESA_TRANSACTION_TYPE=CustomerPayBillOnline
```

The server obtains its own OAuth token, starts an STK Push, matches the callback by `CheckoutRequestID`, and checks the amount and phone number before unlocking an entry. The callback endpoint is:

```text
POST /api/payments/callback
```

Use a public HTTPS URL reachable by Safaricom. Never expose Daraja secrets to the React app. The website never asks for an M-Pesa PIN; customers enter it only in the phone's official prompt.

## Important before a real launch

This is a functional reference implementation, not a claim of legal or production certification.

- Paid chance-based prize promotions in Kenya may require **Betting Control and Licensing Board (BCLB)** authorisation and other approvals. Obtain qualified Kenyan legal advice and all required approvals before accepting money.
- Replace the single-process JSON store with a production database and atomic payment/entry transactions. Add durable idempotency, reconciliation, refund handling, monitoring, backups, rate limiting, and queue-based callback processing.
- Complete an independent security review and fairness audit. Commitments and hash chains make changes detectable; they do not prove the operator's infrastructure is secure or legally compliant.
- Publish operator identity, final event/prize details, eligibility, claim deadlines, cancellation/refund rules, a Kenya Data Protection Act-compliant privacy notice, and responsible-participation controls.
- Remove demo seed entries before a real campaign and keep the outcome-pool secret in a properly secured secrets/data store.
- Verify Daraja callback behaviour against Safaricom's current documentation and your shortcode type.

## Main files

- `src/App.jsx` — page, entry flow, wheel interaction, and entrant result reveal
- `src/Modals.jsx` — checkout, result, verification, and policy dialogs
- `src/Wheel.jsx` — responsive SVG wheel animation
- `src/styles.css` — full responsive visual system
- `server/campaign.js` — committed pool, payment ordering, receipts, and public projections
- `server/daraja.js` — server-only Safaricom Daraja integration
- `server/index.js` — API, callback handling, and app server
- `server/campaign.test.js` — core fairness and integrity tests
