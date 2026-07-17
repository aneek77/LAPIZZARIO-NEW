# La Pizzariô — Online Ordering System

A complete, self-contained ordering system with **fully automatic payment verification** — no human checking required.

- **Customer site** (`/`) — full menu, offers, cart, checkout, pays via UPI/card
- **Staff dashboard** (`/staff`) — every order that appears is **already paid & verified**; staff just tap "Start preparing"
- **Backend** (`server.js`) — zero dependencies, needs only Node.js 18+

## How the automatic verification works

1. Customer checks out → the **server** computes the total from its own price list (a tampered browser cannot change prices).
2. Server creates a Razorpay order → customer pays via any UPI app / card in the Razorpay popup.
3. Razorpay returns a **cryptographic signature** → the server verifies it with your secret key, **and** double-checks the payment status + exact amount live against Razorpay's API.
4. Only then does the order become **PAID** and appear on the staff dashboard.
5. A **webhook** acts as a second, independent confirmation path (covers cases where the customer's browser closes mid-payment).

A fake "I paid" is impossible: an order that isn't confirmed by Razorpay never reaches the kitchen. Money settles automatically to the bank account linked in Razorpay (usually T+1 day).

> **Important:** the old personal Paytm QR (`9732011051@ptsbi`) cannot be auto-verified — personal UPI IDs have no API. Razorpay replaces it: customers still pay by UPI, but the money goes through the gateway into your linked bank account.

## Setup (one-time, ~30 minutes)

### 1. Razorpay account
1. Sign up at https://razorpay.com → complete KYC (PAN, bank account, business details).
2. Dashboard → **Settings → API Keys → Generate Key** → note the **Key ID** and **Key Secret**.
3. Start in **Test Mode** first (test keys begin `rzp_test_`) — you can simulate payments without real money.

### 2. Deploy the server
Any Node.js host works — Render, Railway, a VPS, etc. Example with Render (free tier available):
1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command: *(leave empty)* · Start command: `node server.js`
4. Add environment variables (see `.env.example`):
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
   - `STAFF_PIN` — change from the default `2468`!
   - `RAZORPAY_WEBHOOK_SECRET` — set in step 3
5. Deploy → you get a URL like `https://lapizzario.onrender.com`

### 3. Webhook (recommended)
1. Razorpay Dashboard → **Settings → Webhooks → Add New Webhook**
2. URL: `https://YOUR-DOMAIN/api/webhook/razorpay`
3. Secret: any strong random string → also set it as `RAZORPAY_WEBHOOK_SECRET` on the server
4. Events: tick **payment.captured**

### 4. Test, then go live
- In Test Mode, place an order and pay with Razorpay's test UPI (`success@razorpay`).
- Check `/staff` — the order should appear as **PAID** within seconds.
- Switch to Live keys when ready.

### 5. Order confirmation emails (Brevo, free)
1. Sign up at https://www.brevo.com (free plan: 300 emails/day).
2. **Senders & IP → Senders → Add a sender** — verify the email address orders will be sent *from*.
3. **SMTP & API → API Keys → Generate a new API key**.
4. Set env vars: `BREVO_API_KEY`, `EMAIL_FROM` (the verified sender), `EMAIL_FROM_NAME`, and `BASE_URL` (your site's public URL, used in the email's tracking link).
5. Every confirmed order (online-paid or COD) now automatically emails the customer a branded summary with a live tracking link. If email isn't configured, orders still work — the email is simply skipped.

### 6. Live tracking & delivery riders
- Customers get a tracking page at `/track/ORDER-ID` (linked from the confirmation screen and email): live status timeline, and — for deliveries — the rider's name, phone and a call button.
- Staff: tap **🛵 Drivers** on the dashboard once to save each branch's riders. When an order is ready, tap **Out for delivery** and pick the rider — the customer's tracking page updates instantly.

## Daily use
- Staff open `https://YOUR-DOMAIN/staff`, pick their branch, enter the PIN.
- New paid orders pop in automatically (with a chime) → **Start preparing → Mark ready → Complete**.
- "Unpaid / Abandoned" tab shows customers who opened payment but never paid — never prepare those.
- Cancellations/refunds: cancel on the dashboard, then refund the payment in the Razorpay dashboard (one click).

## Notes
- Orders are stored in `db.json` next to `server.js` — simple and reliable for a single shop. If you grow to thousands of orders/day, migrate to a real database (SQLite/Postgres).
- Prices/menu changes: edit the `MENU` table in **both** `server.js` (source of truth for billing) and `public/index.html` (display).
- Razorpay fee is ~2% per transaction (UPI is often lower/zero on some plans — check current pricing).
