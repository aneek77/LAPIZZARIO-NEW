#!/usr/bin/env node
/* ============================================================
   La Pizzariô — Backend server
   Zero-dependency Node.js (requires Node 18+)

   • Serves the customer site (/) and staff dashboard (/staff)
   • Creates orders with SERVER-SIDE pricing (clients cannot
     tamper with prices or totals)
   • Payments via Razorpay: verified AUTOMATICALLY by
     cryptographic signature + a live check with Razorpay's API.
     No human verification needed. Staff only see PAID orders.
   • Webhook endpoint as a second, independent confirmation path.

   Run:   RAZORPAY_KEY_ID=xxx RAZORPAY_KEY_SECRET=xxx node server.js
   ============================================================ */
'use strict';
const http = require('http');
// Prefer IPv4 — fixes "fetch failed" on networks with broken IPv6 (very common on Windows/college networks)
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) {}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------- CONFIG (env vars) ------------------- */
const CFG = {
  PORT: process.env.PORT || 3000,
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  STAFF_PIN: process.env.STAFF_PIN || '2468',
  DB_FILE: process.env.DB_FILE || path.join(__dirname, 'db.json'),
  /* Email (Brevo — free at brevo.com): order summary is emailed automatically */
  BREVO_API_KEY: process.env.BREVO_API_KEY || '',
  EMAIL_FROM: process.env.EMAIL_FROM || '',                    // must be a verified sender in Brevo
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME || 'La Pizzariô',
  BASE_URL: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''), // used for tracking links in emails
};

const BRANCHES = ['Bidhannagar','Chandidas','S.B. More','Prantika','Raniganj','Asansol','Bolpur'];

/* ============================================================
   DELIVERY AREA CHECK — "out of range" blocking
   ------------------------------------------------------------
   Fill in the PIN codes each branch actually delivers to.
   A branch with an EMPTY array here delivers everywhere (no
   blocking) — so nothing breaks until you add real data.
   Once you list even one PIN code for a branch, delivery to any
   OTHER PIN code for that branch is blocked automatically, and
   the customer is told to try Pickup or a different branch.
   Example:  'Asansol': ['713301','713302','713303'],
   ============================================================ */
const SERVICEABLE_PINCODES = {
  'Bidhannagar': ['713212'],
  'Chandidas':   ['713205','713204'],
  'S.B. More':   ['713201'],
  'Prantika':    ['713204','713203'],
  'Raniganj':    ['713347'],
  'Asansol':     ['713304'],
  'Bolpur':      ['731235'],
};
function pincodeAllowed(branch, pincode) {
  const list = SERVICEABLE_PINCODES[branch] || [];
  if (list.length === 0) return true;   // unconfigured branch = no restriction yet
  return list.includes(String(pincode || '').trim());
}

/* ------------------- MENU: single source of truth -------------------
   The server recomputes every order total from this table.
   Whatever prices a tampered client sends are IGNORED.           */
const MENU = [
 // Veg pizzas (pz = counts for the BOGO offer)
 {n:'Hawain Pizza', isPizza:1, pz:1, p:{Small:240,Medium:360,Large:570}},
 {n:'Pizzario Garden Fresh', isPizza:1, pz:1, p:{Small:170,Medium:280,Large:430}},
 {n:'Veggie Deluxe', isPizza:1, pz:1, p:{Small:230,Medium:340,Large:470}},
 {n:'Cheesy Mushroom Pizza', isPizza:1, pz:1, p:{Small:150,Medium:260,Large:400}},
 {n:'Cheesy Tomato Pizza', isPizza:1, pz:1, p:{Small:130,Medium:250,Large:380}},
 {n:'Classic Veg. Pizza', isPizza:1, pz:1, p:{Small:160,Medium:280,Large:410}},
 {n:'Margherita Pizza', isPizza:1, pz:1, p:{Small:100,Medium:200,Large:320}},
 {n:'Green Pepper Pizza', isPizza:1, pz:1, p:{Small:130,Medium:240,Large:350}},
 {n:'Onion Pizza', isPizza:1, pz:1, p:{Small:120,Medium:230,Large:360}},
 {n:'Golden Corn and Cheese Pizza', isPizza:1, pz:1, p:{Small:140,Medium:260,Large:370}},
 {n:'Veggie Exotica Pizza', isPizza:1, pz:1, p:{Small:240,Medium:360,Large:510}},
 {n:'Paneer Tikka Pizza', isPizza:1, pz:1, p:{Small:250,Medium:380,Large:520}},
 {n:'Corny Paneer Pizza', isPizza:1, pz:1, p:{Small:230,Medium:370,Large:510}},
 {n:'Cheesy Paneer Pizza', isPizza:1, pz:1, p:{Small:230,Medium:370,Large:510}},
 {n:'Paneer Deluxe', isPizza:1, pz:1, p:{Small:260,Medium:390,Large:530}},
 {n:'Kids Delite Pizza', isPizza:1, pz:1, p:{Small:190,Medium:290,Large:410}},
 // Non-veg pizzas
 {n:'Chicken Hawain Pizza', isPizza:1, pz:1, p:{Small:260,Medium:370,Large:550}},
 {n:'Chicken Olicano Pizza', isPizza:1, pz:1, p:{Small:220,Medium:360,Large:510}},
 {n:'Tandoori Chicken Pizza', isPizza:1, pz:1, p:{Small:230,Medium:360,Large:510}},
 {n:'Hot & Spicy Chicken Pizza', isPizza:1, pz:1, p:{Small:230,Medium:360,Large:510}},
 {n:'Golden Corn and Chicken Pizza', isPizza:1, pz:1, p:{Small:200,Medium:310,Large:430}},
 {n:'Chicken Green Pepper Pizza', isPizza:1, pz:1, p:{Small:180,Medium:290,Large:420}},
 {n:'Pizzario Special Pizza', isPizza:1, pz:1, p:{Small:290,Medium:430,Large:620}},
 {n:'Chicken & Onion Pizza', isPizza:1, pz:1, p:{Small:190,Medium:290,Large:430}},
 {n:'Cheesy Chicken Pizza', isPizza:1, pz:1, p:{Small:180,Medium:290,Large:410}},
 {n:'Chicken Deluxe Pizza', isPizza:1, pz:1, p:{Small:260,Medium:370,Large:530}},
 {n:'Sizzling Spicy Kebab Pizza', isPizza:1, pz:1, p:{Small:260,Medium:370,Large:530}},
 {n:'Chicken Supremo Pizza', isPizza:1, pz:1, p:{Small:260,Medium:370,Large:530}},
 {n:'Chicken Salami Lover Pizza', isPizza:1, pz:1, p:{Small:230,Medium:360,Large:510}},
 // Stuffed crust — veg
 {n:'Classic Veg. Cheese St. Crust', isPizza:1, p:{Medium:420,Large:560}},
 {n:'Veggie Exotica St. Crust Pizza', isPizza:1, p:{Medium:430,Large:580}},
 {n:'Golden Corn & Cheese St. Crust', isPizza:1, p:{Medium:370,Large:560}},
 {n:'Paneer Deluxe St. Crust', isPizza:1, p:{Medium:450,Large:600}},
 {n:'Paneer Tikka St. Crust', isPizza:1, p:{Medium:430,Large:580}},
 {n:'Margherita St. Crust', isPizza:1, p:{Medium:360,Large:500}},
 {n:'Corny Paneer St. Crust', isPizza:1, p:{Medium:430,Large:580}},
 {n:'Veg. Hawaiian St. Crust', isPizza:1, p:{Medium:430,Large:580}},
 // Stuffed crust — non-veg
 {n:'Tandoori Chicken Cheese St. Crust', isPizza:1, p:{Medium:430,Large:600}},
 {n:'Hot & Spicy Cheese St. Crust', isPizza:1, p:{Medium:430,Large:600}},
 {n:'Supremo Cheese St. Crust', isPizza:1, p:{Medium:450,Large:630}},
 {n:'Chicken Deluxe St. Crust Pizza', isPizza:1, p:{Medium:450,Large:630}},
 {n:'Chicken Hawaiian St. Crust Pizza', isPizza:1, p:{Medium:450,Large:630}},
 {n:'Golden Corn & Chicken St. Crust', isPizza:1, p:{Medium:380,Large:580}},
 {n:'Pizzario Special St. Crust Pizza', isPizza:1, p:{Medium:490,Large:690}},
 // Veg starters
 {n:'Garlic Bread with Cheese', p:{'':130}},
 {n:'Pizza Pocket Veg.', p:{'':140}},
 {n:'French Fry', p:{'':70}},
 {n:'Pizza Pie Sandwich', p:{'':140}},
 // Non-veg starters
 {n:'Garlic Bread Supreme', p:{'':140}},
 {n:'Fried Chicken Wings', p:{'2 pcs':110,'4 pcs':220}},
 {n:'Chicken Sheekh Kebab', p:{'':180}},
 {n:'Chicken Nuggets', p:{'':100}},
 {n:'Chicken Popcorn', p:{'':100}},
 {n:'Pizza Pocket Chicken', p:{'':170}},
 {n:'Pizza Pie Sandwich Chicken', p:{'':170}},
 // Burgers
 {n:'Veg. Burger', p:{'':70}},
 {n:'Paneer Burger', p:{'':90}},
 {n:'Chicken Burger', p:{'':90}},
 // Desserts
 {n:'Chocolava Cake', p:{'':60}},
 {n:'Brownie', p:{'':60}},
 // Beverages
 {n:'Water', p:{'500 ml':10,'1 L':20}},
 {n:'Cold Drink', p:{'250 ml':20,'200 ml':35,'1 L':55}},
 // Extra toppings
 {n:'Onion (Extra Topping)', p:{Small:20,Medium:30,Large:40}},
 {n:'Capsicum (Extra Topping)', p:{Small:20,Medium:30,Large:40}},
 {n:'Tomato (Extra Topping)', p:{Small:20,Medium:30,Large:40}},
 {n:'Oregano (Extra Topping)', p:{Small:10,Medium:20,Large:30}},
 {n:'Chicken (Extra Topping)', p:{Small:50,Medium:70,Large:110}},
 {n:'Salami (Extra Topping)', p:{Small:60,Medium:80,Large:120}},
 {n:'Cheese (Extra Topping)', p:{Small:60,Medium:80,Large:110}},
 {n:'Paneer (Extra Topping)', p:{Small:60,Medium:80,Large:110}},
 {n:'Mushroom (Extra Topping)', p:{Small:30,Medium:40,Large:60}},
 {n:'Olives (Extra Topping)', p:{Small:30,Medium:40,Large:60}},
 {n:'Jalapenos (Extra Topping)', p:{Small:30,Medium:40,Large:50}},
 {n:'Sweet Corn (Extra Topping)', p:{Small:30,Medium:40,Large:60}},
 {n:'Kebab (Extra Topping)', p:{Small:80,Medium:120,Large:150}},
 {n:'Pineapple (Extra Topping)', p:{Small:30,Medium:40,Large:60}},
 // Combos / offers
 {n:'Executive Meal (Veg)', p:{'':290}},
 {n:'Executive Meal (Non-Veg)', p:{'':310}},
 {n:'Combo Meal Burger (Veg)', p:{'':140}},
 {n:'Combo Meal Burger (Non-Veg)', p:{'':160}},
 {n:'Burger + Dessert Combo (Veg)', p:{'':140}},
 {n:'Burger + Dessert Combo (Non-Veg)', p:{'':160}},
 {n:'Meal for Two (Veg)', p:{'':450}},
 {n:'Meal for Two (Non-Veg)', p:{'':480}},
 {n:'Meal for Four (Veg)', p:{'':650}},
 {n:'Meal for Four (Non-Veg)', p:{'':660}},
];
const PRICE = {};
MENU.forEach(m => Object.entries(m.p).forEach(([v, pr]) => {
  PRICE[m.n + '|' + v] = {price: pr, pz: !!m.pz, isPizza: !!m.isPizza};
}));

/* ------------------- Tiny JSON-file database ------------------- */
let db = {orders: {}};
try { db = JSON.parse(fs.readFileSync(CFG.DB_FILE, 'utf8')); } catch (e) {}
if (!db.orders) db.orders = {};
if (!db.drivers) db.drivers = {};   // { branchName: [ {name, phone} ] }
let saveT = null;
function saveDB() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { fs.writeFileSync(CFG.DB_FILE, JSON.stringify(db, null, 1)); }
    catch (e) { console.error('DB save failed:', e.message); }
  }, 150);
}

/* ------------------- Helpers ------------------- */
function newOid() {
  const d = new Date();
  const ds = String(d.getFullYear()).slice(2) + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  let oid;
  do { oid = 'LP-' + ds + '-' + crypto.randomInt(1000, 9999); } while (db.orders[oid]);
  return oid;
}

/* ============================================================
   FIRST-ORDER DISCOUNT — welcomes new online customers
   ------------------------------------------------------------
   15% off a customer's first successfully paid order, capped so
   one big first order doesn't cost too much. Does NOT stack with
   the BOGO offer — whichever discount is bigger for that order
   wins; never both. Set enabled:false to switch off entirely.
   ============================================================ */
const FIRST_ORDER_DISCOUNT = { enabled: true, percent: 15, maxOff: 100 };
function isFirstOrder(phone) {
  return !Object.values(db.orders).some(o =>
    o.phone === phone && ['PAID','PREPARING','READY','DONE'].includes(o.status)
  );
}

function computeTotal(rawItems, type, phone) {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 60)
    throw new Error('Cart is empty or invalid.');
  let sub = 0;
  const items = [];
  for (const it of rawItems) {
    const key = String(it.name || '') + '|' + String(it.variant || '');
    const rec = PRICE[key];
    if (!rec) throw new Error('Unknown menu item: ' + (it.name || '?'));
    const qty = Math.max(1, Math.min(50, parseInt(it.qty, 10) || 1));
    sub += rec.price * qty;
    const opt = String(it.opt || '').slice(0, 60);
    items.push({name: it.name, variant: it.variant || '', qty, price: rec.price, pz: rec.pz, isPizza: rec.isPizza, opt});
  }
  const hasTopping = items.some(c => c.name.endsWith('(Extra Topping)'));
  const hasPizza = items.some(c => c.isPizza);
  if (hasTopping && !hasPizza)
    throw new Error('Extra toppings need a pizza in the same order — please add a pizza first.');
  // BOGO: Mon(1)/Fri(5), pickup only — cheapest small pizza free per large pizza
  let bogoDiscount = 0;
  const day = new Date().getDay();
  if (type === 'Pickup' && (day === 1 || day === 5)) {
    const larges = items.filter(c => c.pz && c.variant === 'Large').reduce((s,c)=>s+c.qty, 0);
    const smalls = [];
    items.filter(c => c.pz && c.variant === 'Small').forEach(c => { for (let i=0;i<c.qty;i++) smalls.push(c.price); });
    smalls.sort((a,b)=>a-b);
    bogoDiscount = smalls.slice(0, Math.min(larges, smalls.length)).reduce((s,p)=>s+p, 0);
  }
  // First-order discount — only counted if it beats BOGO (never stacked)
  let firstOrderDiscount = 0;
  const eligible = FIRST_ORDER_DISCOUNT.enabled && phone && isFirstOrder(phone);
  if (eligible) {
    firstOrderDiscount = Math.min(Math.round(sub * FIRST_ORDER_DISCOUNT.percent / 100), FIRST_ORDER_DISCOUNT.maxOff);
  }
  const discount = Math.max(bogoDiscount, firstOrderDiscount);
  const discountType = discount === 0 ? null : (bogoDiscount >= firstOrderDiscount ? 'BOGO' : 'FIRST_ORDER');
  return {items, sub, discount, discountType, total: sub - discount};
}

async function razorpay(apiPath, method, body) {
  const auth = Buffer.from(CFG.RAZORPAY_KEY_ID + ':' + CFG.RAZORPAY_KEY_SECRET).toString('base64');
  let res;
  try {
    res = await fetch('https://api.razorpay.com' + apiPath, {
      method,
      headers: {Authorization: 'Basic ' + auth, 'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    console.error('Network error reaching Razorpay:', e.cause ? e.cause.message : e.message);
    throw new Error('Could not reach the payment gateway from this computer — check internet/firewall (allow Node.js in Windows Firewall, or try a mobile hotspot).');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.description) || ('Razorpay error ' + res.status));
  return data;
}

function hmacOK(payload, secret, expected) {
  const digest = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(expected || '')));
  } catch (e) { return false; }
}

function esc(s){ return String(s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function orderEmailHTML(o) {
  const INR = n => '₹' + Number(n||0).toLocaleString('en-IN');
  const rows = o.items.map(i =>
    `<tr><td style="padding:7px 10px;border-bottom:1px dashed #E3D5B8">${esc(i.name)}${i.variant?' ('+esc(i.variant)+')':''}${i.opt?' · '+esc(i.opt):''} × ${i.qty}</td><td align="right" style="padding:7px 10px;border-bottom:1px dashed #E3D5B8;font-weight:bold">${INR(i.price*i.qty)}</td></tr>`).join('');
  const payLine = `✅ Paid online — verified automatically`;
  const track = CFG.BASE_URL + '/track/' + o.oid;
  return `<!DOCTYPE html><html><body style="margin:0;background:#F8EFDC;font-family:Georgia,serif;color:#241F16">
  <div style="max-width:560px;margin:0 auto;padding:24px 14px">
    <div style="background:#123A24;border-radius:16px 16px 0 0;padding:22px;text-align:center">
      <div style="font-size:26px;font-weight:bold;color:#FFFAEE">La <span style="color:#D9A441">Pizzariô</span></div>
      <div style="font-size:11px;letter-spacing:3px;color:#F0D9A8">THE BEST PIZZA IN TOWN</div>
    </div>
    <div style="background:#FFFAEE;padding:24px;border:1px solid #E3D5B8;border-top:none;border-radius:0 0 16px 16px">
      <h2 style="margin:0 0 4px">Order confirmed — thank you, ${esc(o.name.split(' ')[0])}! 🍕</h2>
      <p style="margin:0 0 16px;color:#5C5343">Order <b>${o.oid}</b> · ${o.type} · ${esc(o.branch)} branch</p>
      <table width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;background:#F8EFDC;border-radius:10px;overflow:hidden">
        ${rows}
        ${o.discount>0?`<tr><td style="padding:7px 10px;color:#1E5B38;font-weight:bold">BOGO discount</td><td align="right" style="padding:7px 10px;color:#1E5B38;font-weight:bold">−${INR(o.discount)}</td></tr>`:''}
        <tr><td style="padding:10px;font-weight:bold;font-size:16px;border-top:2px solid #E3D5B8">Total</td><td align="right" style="padding:10px;font-weight:bold;font-size:16px;border-top:2px solid #E3D5B8">${INR(o.total)}</td></tr>
      </table>
      <p style="margin:16px 0 6px;font-weight:bold">${payLine}</p>
      ${o.type==='Delivery'?`<p style="margin:0 0 6px;color:#5C5343">🏠 Delivering to: ${esc(o.address)}${o.pincode?' — PIN '+esc(o.pincode):''}</p>`:`<p style="margin:0 0 6px;color:#5C5343">🏪 Pickup from our ${esc(o.branch)} branch</p>`}
      ${o.notes?`<p style="margin:0 0 6px;color:#5C5343">📝 Notes: ${esc(o.notes)}</p>`:''}
      <div style="text-align:center;margin:22px 0 8px">
        <a href="${track}" style="background:#A8271F;color:#fff;text-decoration:none;font-weight:bold;padding:13px 28px;border-radius:99px;display:inline-block">🔎 Track your order live</a>
      </div>
      <p style="text-align:center;color:#5C5343;font-size:12px;margin:14px 0 0">You'll see live status updates — and your delivery rider's name &amp; number once the order is on its way.<br>Free home delivery · Cheese loaded in every bite</p>
    </div>
  </div></body></html>`;
}
async function sendOrderEmail(o) {
  if (!CFG.BREVO_API_KEY || !CFG.EMAIL_FROM || !o.email) return false;
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {'api-key': CFG.BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json'},
      body: JSON.stringify({
        sender: {name: CFG.EMAIL_FROM_NAME, email: CFG.EMAIL_FROM},
        to: [{email: o.email, name: o.name}],
        subject: `🍕 Order ${o.oid} confirmed — La Pizzariô (${o.type})`,
        htmlContent: orderEmailHTML(o),
      }),
    });
    if (!res.ok) { console.error('Email failed:', res.status, await res.text().catch(()=>'')); return false; }
    console.log('📧 Emailed order summary', o.oid, '→', o.email);
    return true;
  } catch (e) { console.error('Email error:', e.message); return false; }
}

function markPaid(o, paymentId, via) {
  if (o.status !== 'CREATED') return; // idempotent — webhook + confirm may both fire
  o.status = 'PAID';
  o.paymentId = paymentId;
  o.paidVia = via;
  o.paidAt = Date.now();
  o.history.push({s: 'PAID', t: Date.now()});
  saveDB();
  console.log('✅ PAID', o.oid, o.total, 'via', via);
}

/* ------------------- HTTP plumbing ------------------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new Error('Payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8','.xml':'application/xml; charset=utf-8'};
function serveStatic(res, file) {
  const full = path.join(__dirname, 'public', file);
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(full)] || 'application/octet-stream'});
    res.end(data);
  });
}
function staffOK(req) {
  return (req.headers['x-staff-pin'] || '') === CFG.STAFF_PIN;
}
const publicOrder = o => ({ok:true, oid:o.oid, status:o.status, total:o.total, sub:o.sub, discount:o.discount, discountType:o.discountType||null,
  type:o.type, branch:o.branch, ts:o.ts, pay:o.pay, firstName:(o.name||'').split(' ')[0],
  items:o.items, driver:o.driver||null, history:o.history||[]});

/* ------------------- Router ------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    /* ---------- static ---------- */
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && (p === '/staff' || p === '/staff.html')) return serveStatic(res, 'staff.html');
    if (req.method === 'GET' && (p === '/track' || p.startsWith('/track/'))) return serveStatic(res, 'track.html');
    if (req.method === 'GET' && (p === '/about' || p === '/about.html')) return serveStatic(res, 'about.html');
    if (req.method === 'GET' && p.startsWith('/images/')) return serveStatic(res, p.slice(1));
    if (req.method === 'GET' && p === '/robots.txt') return serveStatic(res, 'robots.txt');
    if (req.method === 'GET' && p === '/sitemap.xml') return serveStatic(res, 'sitemap.xml');

    /* ---------- health ---------- */
    if (req.method === 'GET' && p === '/api/health') {
      return send(res, 200, {ok:true, gateway: !!(CFG.RAZORPAY_KEY_ID && CFG.RAZORPAY_KEY_SECRET), webhook: !!CFG.RAZORPAY_WEBHOOK_SECRET});
    }

    /* ---------- live delivery-range check (instant feedback while typing) ---------- */
    if (req.method === 'GET' && p === '/api/delivery-check') {
      const branch = url.searchParams.get('branch') || '';
      const pincode = String(url.searchParams.get('pincode') || '').trim();
      if (!BRANCHES.includes(branch)) return send(res, 400, {ok:false, error:'Invalid branch.'});
      if (!/^\d{6}$/.test(pincode)) return send(res, 200, {ok:true, valid:false});
      return send(res, 200, {ok:true, valid:true, deliverable: pincodeAllowed(branch, pincode)});
    }

    if (req.method === 'GET' && p === '/api/first-order-check') {
      const phone = String(url.searchParams.get('phone') || '').trim();
      if (!/^[6-9]\d{9}$/.test(phone)) return send(res, 200, {ok:true, valid:false});
      const eligible = FIRST_ORDER_DISCOUNT.enabled && isFirstOrder(phone);
      return send(res, 200, {ok:true, valid:true, eligible, percent: FIRST_ORDER_DISCOUNT.percent, maxOff: FIRST_ORDER_DISCOUNT.maxOff});
    }

    /* ---------- create order (customer) ---------- */
    if (req.method === 'POST' && p === '/api/orders') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const name = String(b.name || '').trim().slice(0, 80);
      const phone = String(b.phone || '').trim();
      const type = b.type === 'Pickup' ? 'Pickup' : 'Delivery';
      const branch = BRANCHES.includes(b.branch) ? b.branch : null;
      const address = String(b.address || '').trim().slice(0, 400);
      const pincode = String(b.pincode || '').trim();
      const notes = String(b.notes || '').trim().slice(0, 400);
      const email = String(b.email || '').trim().slice(0, 120);
      if (name.length < 2) return send(res, 400, {ok:false, error:'Please enter your name.'});
      if (!/^[6-9]\d{9}$/.test(phone)) return send(res, 400, {ok:false, error:'Invalid mobile number.'});
      if (!/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, {ok:false, error:'Please enter a valid email address.'});
      if (!branch) return send(res, 400, {ok:false, error:'Please choose a branch.'});
      if (type === 'Delivery' && address.length < 6) return send(res, 400, {ok:false, error:'Please enter your delivery address.'});
      if (type === 'Delivery') {
        if (!/^\d{6}$/.test(pincode)) return send(res, 400, {ok:false, error:'Please enter a valid 6-digit delivery PIN code.'});
        if (!pincodeAllowed(branch, pincode))
          return send(res, 400, {ok:false, error:`Sorry, PIN code ${pincode} is outside our delivery range for the ${branch} branch. Please choose Pickup instead, or select a closer branch.`});
      }

      let priced;
      try { priced = computeTotal(b.items, type, phone); }
      catch (e) { return send(res, 400, {ok:false, error: e.message}); }
      if (priced.total < 1) return send(res, 400, {ok:false, error:'Invalid order total.'});

      /* ----- Online payment (Razorpay) — the only payment path ----- */
      if (!CFG.RAZORPAY_KEY_ID || !CFG.RAZORPAY_KEY_SECRET)
        return send(res, 503, {ok:false, error:'Online payment is not configured yet. Please call the branch to order.'});

      const oid = newOid();
      const rzpOrder = await razorpay('/v1/orders', 'POST', {
        amount: priced.total * 100,           // paise
        currency: 'INR',
        receipt: oid,
        notes: {oid, branch},
      });
      db.orders[oid] = {
        oid, ts: Date.now(), name, phone, email, type, branch, address, pincode, notes,
        items: priced.items, sub: priced.sub, discount: priced.discount, discountType: priced.discountType, total: priced.total,
        pay: 'ONLINE', rzpOrderId: rzpOrder.id, status: 'CREATED', history: [{s:'CREATED', t: Date.now()}],
      };
      saveDB();
      return send(res, 200, {ok:true, oid, rzpOrderId: rzpOrder.id, keyId: CFG.RAZORPAY_KEY_ID, amount: priced.total * 100, total: priced.total, sub: priced.sub, discount: priced.discount, discountType: priced.discountType});
    }

    /* ---------- inline UPI QR: create a fixed-amount QR for an order ---------- */
    if (req.method === 'POST' && p === '/api/payment/upiqr') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const o = db.orders[String(b.oid || '')];
      if (!o) return send(res, 404, {ok:false, error:'Order not found.'});
      if (o.status !== 'CREATED') return send(res, 200, {ok:true, paid:true, status:o.status});
      if (!CFG.RAZORPAY_KEY_ID || !CFG.RAZORPAY_KEY_SECRET)
        return send(res, 503, {ok:false, error:'Online payment is not configured yet.'});
      if (!o.qrId) {
        let qr;
        try {
          qr = await razorpay('/v1/payments/qr_codes', 'POST', {
          type: 'upi_qr',
          name: 'La Pizzario ' + o.oid,
          usage: 'single_use',
          fixed_amount: true,
          payment_amount: o.total * 100,
          description: 'Order ' + o.oid,
          close_by: Math.floor(Date.now()/1000) + 20*60,
          notes: {oid: o.oid, branch: o.branch},
          });
        } catch (e) {
          if (/not found|not permitted|not enabled/i.test(e.message))
            return send(res, 503, {ok:false, error:'Scan-QR is being set up on our payment account — please use 💳 Pay Online for now (it also supports all UPI apps).'});
          throw e;
        }
        o.qrId = qr.id; o.qrImage = qr.image_url;
        saveDB();
      }
      return send(res, 200, {ok:true, paid:false, qrImage: o.qrImage, amount: o.total});
    }

    /* ---------- poll: has the QR been paid? (auto-verification) ---------- */
    const mq = p.match(/^\/api\/payment\/upiqr\/(LP-[\w-]+)\/status$/);
    if (req.method === 'GET' && mq) {
      const o = db.orders[mq[1]];
      if (!o) return send(res, 404, {ok:false, error:'Order not found.'});
      if (o.status === 'CREATED' && o.qrId) {
        try {
          const pays = await razorpay('/v1/qr_codes/' + encodeURIComponent(o.qrId) + '/payments', 'GET');
          const hit = (pays.items || []).find(x => (x.status === 'captured' || x.status === 'authorized') && Number(x.amount) === o.total * 100);
          if (hit) {
            markPaid(o, hit.id, 'upi-qr');
            if (!o.emailSent) {
              const em = await sendOrderEmail(o);
              if (em) { o.emailSent = true; saveDB(); }
            }
          }
        } catch (e) { /* transient API error — client will poll again */ }
      }
      return send(res, 200, {ok:true, paid: o.status !== 'CREATED', status: o.status, emailed: !!o.emailSent});
    }

    /* ---------- automatic payment verification (checkout callback) ---------- */
    if (req.method === 'POST' && p === '/api/payment/confirm') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const o = db.orders[String(b.oid || '')];
      if (!o) return send(res, 404, {ok:false, error:'Order not found.'});
      if (o.status !== 'CREATED') return send(res, 200, {ok:true, status:o.status}); // already handled (e.g. webhook won the race)
      if (b.razorpay_order_id !== o.rzpOrderId) return send(res, 400, {ok:false, error:'Order mismatch.'});
      // 1) cryptographic signature check
      const payload = b.razorpay_order_id + '|' + b.razorpay_payment_id;
      if (!hmacOK(payload, CFG.RAZORPAY_KEY_SECRET, b.razorpay_signature))
        return send(res, 400, {ok:false, error:'Payment signature invalid.'});
      // 2) independent live check with Razorpay's API: status + amount + order linkage
      const pay = await razorpay('/v1/payments/' + encodeURIComponent(b.razorpay_payment_id), 'GET');
      const captured = pay.status === 'captured' || pay.status === 'authorized';
      if (!captured || pay.order_id !== o.rzpOrderId || Number(pay.amount) !== o.total * 100)
        return send(res, 400, {ok:false, error:'Payment could not be verified.'});
      markPaid(o, b.razorpay_payment_id, 'checkout+api');
      let emailed = !!o.emailSent;
      if (o.status === 'PAID' && !o.emailSent) {
        emailed = await sendOrderEmail(o);
        if (emailed) { o.emailSent = true; saveDB(); }
      }
      return send(res, 200, {ok:true, status:o.status, emailed});
    }

    /* ---------- Razorpay webhook (independent confirmation path) ---------- */
    if (req.method === 'POST' && p === '/api/webhook/razorpay') {
      const raw = await readBody(req);
      if (!CFG.RAZORPAY_WEBHOOK_SECRET) return send(res, 503, {ok:false});
      if (!hmacOK(raw, CFG.RAZORPAY_WEBHOOK_SECRET, req.headers['x-razorpay-signature']))
        return send(res, 400, {ok:false, error:'Bad signature'});
      const ev = JSON.parse(raw.toString());
      if (ev.event === 'payment.captured') {
        const pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
        if (pay) {
          let o = pay.notes && pay.notes.oid ? db.orders[pay.notes.oid] : null;
          if (!o) o = Object.values(db.orders).find(x => x.rzpOrderId === pay.order_id);
          if (o && Number(pay.amount) === o.total * 100) {
            markPaid(o, pay.id, 'webhook');
            if (o.status === 'PAID' && !o.emailSent) sendOrderEmail(o).then(f => { if (f) { o.emailSent = true; saveDB(); } });
          }
        }
      }
      return send(res, 200, {ok:true});
    }

    /* ---------- find my orders by phone (last 24h) ---------- */
    if (req.method === 'GET' && p === '/api/orders/lookup') {
      const phone = String(url.searchParams.get('phone') || '').trim();
      if (!/^[6-9]\d{9}$/.test(phone)) return send(res, 400, {ok:false, error:'Enter a valid 10-digit mobile number.'});
      const cutoff = Date.now() - 24*60*60*1000;
      const list = Object.values(db.orders)
        .filter(o => o.phone === phone && o.ts >= cutoff && o.status !== 'CREATED')
        .sort((a,b) => b.ts - a.ts).slice(0, 10)
        .map(o => ({oid:o.oid, status:o.status, total:o.total, ts:o.ts, type:o.type, branch:o.branch}));
      return send(res, 200, {ok:true, orders:list});
    }

    /* ---------- customer order status (live tracking) ---------- */
    let m = p.match(/^\/api\/orders\/(LP-[\w-]+)$/);
    if (req.method === 'GET' && m) {
      const o = db.orders[m[1]];
      if (!o) return send(res, 404, {ok:false, error:'Order not found.'});
      return send(res, 200, publicOrder(o));
    }

    /* ---------- staff API ---------- */
    if (p.startsWith('/api/staff/')) {
      if (!staffOK(req)) return send(res, 401, {ok:false, error:'Wrong staff PIN.'});

      if (req.method === 'GET' && p === '/api/staff/drivers') {
        const branch = url.searchParams.get('branch') || '';
        return send(res, 200, {ok:true, drivers: db.drivers[branch] || []});
      }
      if (req.method === 'POST' && p === '/api/staff/drivers') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        const branch = BRANCHES.includes(b.branch) ? b.branch : null;
        if (!branch) return send(res, 400, {ok:false, error:'Invalid branch.'});
        db.drivers[branch] = db.drivers[branch] || [];
        if (b.action === 'add') {
          const name = String(b.name || '').trim().slice(0, 60);
          const phone = String(b.phone || '').trim();
          if (name.length < 2) return send(res, 400, {ok:false, error:'Driver name required.'});
          if (!/^[6-9]\d{9}$/.test(phone)) return send(res, 400, {ok:false, error:'Valid 10-digit driver phone required.'});
          db.drivers[branch].push({name, phone});
        } else if (b.action === 'remove') {
          const i = parseInt(b.index, 10);
          if (i >= 0 && i < db.drivers[branch].length) db.drivers[branch].splice(i, 1);
        }
        saveDB();
        return send(res, 200, {ok:true, drivers: db.drivers[branch]});
      }

      if (req.method === 'GET' && p === '/api/staff/orders') {
        const branch = url.searchParams.get('branch');
        let list = Object.values(db.orders);
        if (branch && branch !== 'ALL') list = list.filter(o => o.branch === branch);
        list.sort((a,b) => b.ts - a.ts);
        return send(res, 200, {ok:true, orders: list.slice(0, 400)});
      }

      m = p.match(/^\/api\/staff\/orders\/(LP-[\w-]+)\/status$/);
      if (req.method === 'POST' && m) {
        const o = db.orders[m[1]];
        if (!o) return send(res, 404, {ok:false, error:'Order not found.'});
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        const st = String(b.status || '');
        const flow = {PAID:['PREPARING','CANCELLED'], PREPARING:['READY','CANCELLED'], READY:['DONE']};
        if (!(flow[o.status] || []).includes(st))
          return send(res, 400, {ok:false, error:'Not allowed: ' + o.status + ' → ' + st + '. Payment status is set only by the gateway.'});
        o.status = st;
        if (st === 'READY' && o.type === 'Delivery' && b.driver && b.driver.name) {
          o.driver = {
            name: String(b.driver.name).trim().slice(0, 60),
            phone: String(b.driver.phone || '').trim().slice(0, 12),
          };
        }
        if (st === 'CANCELLED') o.cancelReason = String(b.reason || '').slice(0, 200) || 'Cancelled by staff';
        o.history.push({s: st, t: Date.now()});
        saveDB();
        return send(res, 200, {ok:true, order:o});
      }
    }

    res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not found');
  } catch (e) {
    console.error(req.method, p, '→', e.message);
    send(res, 500, {ok:false, error:'Server error: ' + e.message});
  }
});

server.listen(CFG.PORT, () => {
  console.log('🍕 La Pizzariô server on http://localhost:' + CFG.PORT);
  console.log('   Customer site:  /        Staff dashboard: /staff');
  if (!CFG.RAZORPAY_KEY_ID) console.log('⚠️  RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — payments disabled until configured.');
  if (!CFG.RAZORPAY_WEBHOOK_SECRET) console.log('ℹ️  RAZORPAY_WEBHOOK_SECRET not set — webhook path inactive (checkout verification still works).');
});
