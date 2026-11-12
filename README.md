# TripMate GroupCommit

**Commit together. Pay only when the group is ready.**

TripMate is an AI travel-finance coordinator for groups. Friends plan a shared booking in **one shared AI chat** that keeps **one versioned plan**. Each member then **authorizes** their share with PayPal (funds on hold, nothing charged). An AI **commitment agent** watches the group's readiness, verifies the real payment state through the **PayPal Agent Toolkit**, and, when someone hasn't committed before the deadline, proposes recovery options (cover, re-split, extend, cancel) that the right people approve. Only then does the backend **capture** every hold, or **void** them all.

> AI recommends → humans approve → backend checks → PayPal executes.

Built for the PayPal AI Hackathon 2026. Runs entirely on the PayPal **sandbox**.

---

## The problem

Group bookings break in the gap between "we're all in" and "everyone actually paid". One person fronts the money and chases the others for weeks, or a booking is lost because one friend didn't pay in time. Expense splitters only record debts *after* the fact.

## What TripMate does

1. **Accounts + WhatsApp-style invite links.** Sign up with email and password (scrypt-hashed, JWT session in an httpOnly cookie). Create a trip and share its invite link (`/join/<code>`) by copy, WhatsApp or the phone's share sheet. Friends see a group preview, log in or sign up, and land in the group chat. The organizer can reset the link so the old one stops working.
2. **Shared AI chat, one plan.** Members talk naturally ("Main sirf 2 raat rukungi", "I'll take the private room, $40 extra"). The LLM extracts the facts; a deterministic engine computes exact shares in cents. Every change bumps the plan version and resets approvals, so nobody pays on an outdated plan. A member's statement about *themself* is authoritative; claims about someone else must be confirmed by that person.
3. **GroupCommit with PayPal authorizations.** After everyone approves, each member gets a PayPal link. Approving places an **authorization (hold)**; nothing is charged.
4. **Commitment agent on autopilot.** Nobody has to press a button: a background loop watches every collecting trip. When someone still hasn't committed 35 minutes before the deadline (or after it), or a member says in chat that they can't pay, the agent (LLM + PayPal Agent Toolkit `get_order`) checks every pending order with PayPal, then recommends one of four options with exact, code-computed amounts:
   - **Cover**: a member authorizes the missing share; a balance "X owes Y" is recorded.
   - **Re-split**: the missing member drops out; the others authorize top-ups.
   - **Extend**: move the deadline, only if every existing hold stays valid.
   - **Cancel**: void every hold; nobody is charged.
5. **Human approval with guardrails.** Only the required approvers can vote. If the payment situation changes after a proposal (e.g. the missing member pays), the proposal goes **stale** and cannot execute.
6. **Finalize.** When the group is fully committed, the autopilot tells the organizer in the chat, and the organizer captures every authorization → **FUNDED**. Marking the merchant's confirmation is a separate step → **CONFIRMED**.
7. **Webhooks.** Signature-verified, idempotent PayPal webhooks confirm authorizations, captures and voids, and catch members who approved but closed the tab.

---

## How PayPal is used

| PayPal capability | Where |
|---|---|
| Orders v2, `intent: AUTHORIZE` | One order per share, cover, or top-up (`lib/commit.ts`) |
| `POST /v2/checkout/orders/{id}/authorize` | On return from PayPal: place the hold |
| `POST /v2/payments/authorizations/{id}/capture` | Finalize: collect every hold |
| `POST /v2/payments/authorizations/{id}/void` | Cancel: release every hold |
| `GET /v2/checkout/orders/{id}` | "check PayPal" repair path |
| **PayPal Agent Toolkit** (`@paypal/agent-toolkit/ai-sdk`), `get_order` | The AI agent verifies real order state before recommending (`lib/agent.ts`, `lib/paypalToolkit.ts`) |
| Webhooks + `POST /v1/notifications/verify-webhook-signature` | `app/api/paypal/webhook` + `lib/webhooks.ts` |

Practices from PayPal's AI-Toolkit best-practices skill: server-side order creation, cached OAuth token, `PayPal-Request-Id` on every POST (derived from the order/authorization id so retries can't double-authorize or double-capture), `debug_id` logged on errors.

**Honest limits.** An authorization is a hold, not escrow: capture can still fail, and the app records that (`CAPTURE_FAILED`, trip `AT_RISK`). In this demo the money goes to the app's sandbox Business account, which plays the merchant ("Berlin Backpackers"). Paying independent hostels directly would need PayPal's multiparty/platform onboarding. "Funded" and "Confirmed" are deliberately separate states.

## Where the money goes

Every share is a PayPal Orders v2 `AUTHORIZE` order created by this app's REST credentials, so the **payee is the PayPal business account that owns the app** (in the demo, a US sandbox Business account playing the hostel). PayPal returns that payee (`merchant_id`, email) on each order: the app records it, locks it on the trip, shows it in the **Where the money goes** card, and refuses to capture if any hold would pay a different merchant. Paying an external hotel's own PayPal account directly needs PayPal Multiparty (partner onboarding + the merchant's consent); without it PayPal rejects third-party payees for authorize/capture. That is the production path.

## Shared expenses

On top of the stay (split by nights), members can add shared costs (food, transport, activities) from the plan panel or just in chat ("dinner $60 sabka", "cab $30 me and Priya"). Each expense is split equally among its participants with exact cents; adding one bumps the plan version so everyone re-approves before anyone pays.

## How AI is used

| Where | Model / tool | What it does |
|---|---|---|
| Shared chat (`lib/chat.ts`, `lib/ai.ts`) | Gemini (free tier) via Vercel AI SDK `generateObject`, Groq fallback | Turns messages into structured plan facts (nights, extras, confirmations needed) and replies in the group's language |
| Split engine (`lib/splitEngine.ts`) | **No AI** | Exact cents with the largest-remainder method; the sum always equals the total |
| Commitment agent (`lib/agent.ts`) | Gemini / Groq via `generateText` with tools: `get_commitment_status`, PayPal Agent Toolkit `get_order`, `submit_recommendation` | Verifies PayPal state, picks a recommendation, explains consequences |
| Guardrails | **No AI** | Amounts, approvers, staleness checks and execution are code |
| Autopilot (`lib/autopilot.ts`, `instrumentation.ts`) | Runs the agent above automatically | Every 30 s: deadline near/passed with pending members → agent proposes; all committed → asks organizer to finalize. Humans still approve every money movement |

The agent has **read-only** PayPal access. Creating, capturing and voiding happen only in the backend after the required humans approve. Providers are tried in order (Gemini first, then Groq), so a free-tier rate limit on one doesn't stop the demo. If no AI key is set at all, the app falls back to a simple parser and rule-based recommendations (still PayPal-verified).

---

## Run locally

Requirements: Node 18+ (tested on Node 22).

```bash
npm install
cp .env.example .env      # fill in the values
npm run dev               # http://localhost:3000
```

### PayPal sandbox setup

1. https://developer.paypal.com → **Testing Tools → Sandbox Accounts → Create account**: one **Business** account and a few **Personal** accounts, all with country **United States**. (An India-registered sandbox seller can't receive domestic payments.)
2. **Apps & Credentials → Sandbox → Create App**, linked to the **US Business** account. Put the Client ID and Secret in `.env`.
3. Personal account logins: **Sandbox Accounts → ⋯ → View/Edit account**.

### Environment variables

| Name | Purpose |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox REST app credentials |
| `PAYPAL_API_BASE` | `https://api-m.sandbox.paypal.com` |
| `GEMINI_API_KEY` | Free key from https://aistudio.google.com/apikey |
| `GEMINI_MODEL` | default `gemini-3.5-flash-lite` (comma-separated list allowed; 2.x models are closed to new keys) |
| `GROQ_API_KEY` | Free key from https://console.groq.com/keys (fallback) |
| `GROQ_MODEL` | default `llama-3.3-70b-versatile` |
| `AI_PROVIDER` | optional; `groq` to try Groq first |
| `APP_URL` | Public URL when deployed (PayPal return/cancel URLs) |
| `PAYPAL_WEBHOOK_ID` | Webhook id, needed to verify webhook signatures |
| `JWT_SECRET` | Long random string that signs login sessions (required in production; Render generates one) |
| `RESEND_API_KEY`, `RESEND_FROM` | Optional: email the forgot-password link. Without it the link shows on screen in dev, or when `DEMO_SHOW_RESET_LINK=true` |

### Demo script (two or more browser windows)

Each window is a different person; use a private/incognito window for the second person and sign up with a different email.

1. **Window A**: sign up as "Aman" → **Create trip** (Berlin Trip, $280) → **+ Invite** → **Copy link** (or Share on WhatsApp).
2. **Window B**: open the link → **Log in or sign up to join** → sign up as "Priya" → you land in the group chat. (Add a third window for "Rohit".)
3. In the chat: Priya: *"Main sirf 2 raat rukungi"*. Aman: *"I'll take the private room, $40 extra"*. Watch the plan version update.
4. Everyone **Approve my share** → Aman **Start GroupCommit**.
5. Aman and Priya click **Commit with PayPal ↗** and log in with sandbox Personal accounts → 🔒 on hold. Rohit doesn't.
6. Aman: **⏰ Demo: deadline in 30 min** → the autopilot notices, the agent checks PayPal and posts recovery options in the chat. (Or Rohit types *"sorry, I can't pay"* in the chat.)
7. Aman approves **Cover** → commits the new link → **Finalize: capture all** → FUNDED → **Mark hostel confirmed**. Balances show "Rohit owes Aman".
8. Try **Re-split** (everyone affected must approve, then top-ups), **Extend**, or **Cancel** (all holds voided) on another trip.

---

## Deploy (Render)

1. Push this repo to GitHub (public).
2. Render → **New → Web Service** → your repo. Build `npm install && npm run build`, start `npm start`. (`render.yaml` is included.)
3. Add the environment variables above. After the first deploy, set `APP_URL` to the Render URL and redeploy.
4. Webhooks: developer.paypal.com → your app → **Sandbox Webhooks → Add Webhook** → URL `https://<your-app>.onrender.com/api/paypal/webhook`, events `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`.

Data is stored in a JSON file (`data/store.json`). On Render's free tier the disk is ephemeral, so trips reset when the service restarts. That is fine for a demo; production would use a database.

## Project structure

```
app/
  page.tsx                     My trips + create trip
  t/[id]/page.tsx              Trip: shared chat, plan, GroupCommit board, agent cards, balances, timeline
  api/trips/...                trips, join, plan, messages (AI chat), commit, agent (run/vote)
  api/paypal/return|cancel     PayPal redirect → authorize
  api/paypal/webhook           verified webhooks
lib/
  paypal.ts        Orders v2 + Payments v2 REST helper
  paypalToolkit.ts PayPal Agent Toolkit (read-only tools for the agent)
  commit.ts        GroupCommit: start, authorize, finalize (capture), void
  agent.ts         Commitment agent: options, AI run, votes, guarded execution
  chat.ts, ai.ts   Shared chat + LLM prompts (Gemini, Groq fallback)
  splitEngine.ts   Deterministic split in cents
  trips.ts, store.ts, webhooks.ts, money.ts
```

## License

MIT, see [LICENSE](LICENSE).
