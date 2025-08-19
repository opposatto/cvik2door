const TelegramBot = require('node-telegram-bot-api');
const dotenv = require('dotenv');
dotenv.config();
const fs = require('fs');
const path = require('path');

// simple HTML-escape helper for admin-facing messages
function escapeHtml(s) {
  if (!s && s !== 0) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Normalize ADMIN_ID: accept plain numbers or values like "$env:12345" by extracting digits
let ADMIN_ID = null;
if (process.env.ADMIN_ID) {
  const digits = String(process.env.ADMIN_ID).replace(/\D/g, '');
  ADMIN_ID = digits ? Number(digits) : null;
}
if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN environment variable');
  process.exit(1);
}

// debug: print resolved ADMIN_ID (helps if .env had non-numeric value)
console.log('Resolved ADMIN_ID=', ADMIN_ID);

// Create bot without starting polling immediately. We'll delete any webhook and
// then start polling to avoid '409 Conflict: terminated by other getUpdates request'
const bot = new TelegramBot(TOKEN, { polling: false });

// centralized keyboards (refactor)
const K = require('./keyboards');

// Small instance identifier to help diagnose duplicate-update problems across processes
const INSTANCE_ID = `${process.pid}-${Math.random().toString(16).slice(2,8)}`;

// DEBUG: log incoming messages to help diagnose why the bot may not respond or why updates appear duplicated.
// Enhanced to include instance id, pid, message_id and timestamp so duplicate sources are identifiable.
bot.on('message', (m) => {
  try {
    const who = m.from ? `${m.from.id}${m.from.username ? '(@' + m.from.username + ')' : ''}` : 'unknown';
    const chat = m.chat ? `${m.chat.id}${m.chat.type ? '/' + m.chat.type : ''}` : 'no-chat';
    const text = m.text ? m.text.replace(/\n/g, '\\n') : (m.location ? '[location]' : '[non-text]');
    const mid = (typeof m.message_id !== 'undefined') ? m.message_id : 'no-msgid';
    const date = m.date ? new Date(m.date * 1000).toISOString() : '';
    console.log(`[INCOMING] inst=${INSTANCE_ID} pid=${process.pid} msgid=${mid} date=${date} from=${who} chat=${chat} text=${text}`);
  } catch (e) { console.log(`[INCOMING] parse error inst=${INSTANCE_ID}`, e && e.message); }
});

// Polling error suppression/backoff state
const pollingErrorState = { count: 0, suppressedUntil: 0, lastErrText: null };

// Handle polling errors with exponential backoff logging and stop/start polling to reduce noise
bot.on('polling_error', (err) => {
  try {
    const now = Date.now();
    const errText = (err && err.message) ? `${err.code || ''} ${err.message}`.trim() : String(err);
    // If same error recently suppressed, ignore
    if (pollingErrorState.lastErrText === errText && now < pollingErrorState.suppressedUntil) return;
    // increment count (reset if different error)
    if (pollingErrorState.lastErrText !== errText) {
      pollingErrorState.count = 1;
      pollingErrorState.lastErrText = errText;
    } else {
      pollingErrorState.count++;
    }
    // exponential backoff: base 1s, cap 5 minutes
    const backoffMs = Math.min(5 * 60 * 1000, 1000 * Math.pow(2, Math.max(0, pollingErrorState.count - 1)));
    pollingErrorState.suppressedUntil = now + backoffMs;
    console.error(`[polling_error] ${errText} — suppressing further identical errors for ${Math.round(backoffMs/1000)}s (count=${pollingErrorState.count})`);
    // include stack if available for first occurrence
    if (pollingErrorState.count === 1 && err && err.stack) console.error(err.stack);

    // stop polling to prevent repeated internal logs, then restart after backoff
    if (!pollingErrorState.stopped) {
      try {
        pollingErrorState.stopped = true;
        bot.stopPolling && bot.stopPolling();
        console.warn(`[polling_error] stopped polling; will restart in ${Math.round(backoffMs/1000)}s`);
      } catch (e) {
        console.error('Failed to stop polling', e && e.message);
      }
      setTimeout(() => {
        try {
          bot.startPolling && bot.startPolling();
          pollingErrorState.stopped = false;
          console.warn('[polling_error] restarted polling after backoff');
        } catch (e) {
          console.error('Failed to restart polling', e && e.message);
        }
      }, backoffMs);
    }

    // schedule a reset of count if no further errors after backoff window
    setTimeout(() => {
      if (Date.now() >= pollingErrorState.suppressedUntil) {
        pollingErrorState.count = 0;
        pollingErrorState.lastErrText = null;
      }
    }, backoffMs + 1000);
  } catch (e) {
    // fallback logging
    console.error('polling_error handler failed', e && e.message);
  }
});
// In-memory stores
const orders = [];
const drivers = [];
const customers = [];
const sessions = [];
const qrCodes = [];
// shift profiles: simple admin-defined profiles and completed shifts
const shiftProfiles = [];
// runtime-only maps
// sessionTimers: sessionId -> { timeout, interval }
const sessionTimers = new Map(); // sessionId -> { timeout, interval }
const adminPendingQR = new Map(); // adminId -> qrId (waiting for media/text)
const driverApprovalMessages = new Map(); // driverId -> { chatId, messageId }
const adminSentMessages = new Map(); // messageId -> { orderId?, type }

// Group logging removed: feature disabled to simplify the scaffold.
const GROUP_LOG_ROTATE_BYTES = Number(process.env.GROUP_LOG_ROTATE_BYTES || (5 * 1024 * 1024)); // retained for SETTINGS defaults

const DATA_FILE = path.join(__dirname, 'data.json');

// app-wide settings (persisted)
let SETTINGS = {
  // groupLogRotateBytes removed from live settings (UI deprecated)
  archiveDays: 7
};

let orderCounter = 1;
let profileCounter = 1;
// load persisted data (after in-memory arrays exist)
loadData();

// internal promise used to serialize saveData calls and avoid concurrent writes
let _savePromise = Promise.resolve();

// Simple translations
const MESSAGES = {
  en: {
    welcome: name => `Welcome ${name || 'friend'}!\nUse the inline UI to order or send items as text.`,
    reg_sent: 'Registration sent to admin for approval.',
    reg_approved: 'Registration approved! You can now /connect',
    now_online: 'You are now online 🟢',
    now_offline: 'You are now offline 🔴',
    start_live_prompt: 'Please send your live location now (use Telegram location attachment)',
  no_active_live: 'No active live session. Use START LIVE before sending location.',
  live_started: (name, until) => `${name} started sharing live location (valid until ${until}).`,
  live_stopped: name => `${name} stopped sharing live location.`,
  live_expired: 'Live location session expired.',
  live_ended: 'Driver live location sharing has ended.',
  live_shared: (name, until) => `${name} shared live location (valid until ${until}).`,
  location_saved: 'Location saved to your order.',
  unsupported_qr_payload: 'Unsupported QR payload — send a photo, document, or text.',
  payment_received: id => `Thanks — payment received for order #${String(id).padStart(4,'0')}.`,
  picked_up_notify: id => `Your order #${String(id).padStart(4,'0')} has been picked up. 🚀`,
  arrived_notify: id => `Hi, your order #${String(id).padStart(4,'0')} has arrived. Please collect your order.`
  ,
  marked_paid: 'Marked as PAID',
  order_not_found: 'Order not found',
  no_admin: 'No admin set',
  qr_or_order_not_found: 'QR or order not found',
  order_no_customer: 'Order has no customer',
  qr_sent: 'QR sent to customer'
  },
  kh: {
    welcome: name => `សូមស្វាគមន៍ ${name || ''}!\nប្រើ UI ដើម្បីបញ្ជាទិញ ឬផ្ញើររបស់។`,
    reg_sent: 'ការចុះបញ្ជីបានផ្ញើទៅអ្នកគ្រប់គ្រងសម្រាប់អនុម័ត។',
    reg_approved: 'បានអនុម័ត! អ្នកឥឡូវអាច /connect',
    now_online: 'អ្នកត្រូវបានភ្ជាប់ 🟢',
    now_offline: 'អ្នកបានបិទ🔴',
    start_live_prompt: 'សូមផ្ញើទីតាំងបច្ចុប្បន្ន (location)',
  no_active_live: 'មិនមានសន្និសីទផ្តល់ទីតាំង។ សូមចាប់ផ្តើម START LIVE',
  live_started: (name, until) => `${name} បានចែករំលែកទីតាំង (មានសុពលភាពរហូតដល់ ${until})។`,
  live_stopped: name => `${name} បានបញ្ឈប់ការចែករំលែកទីតាំង។`,
  live_expired: 'សន្និសីទផ្ដល់ទីតាំងបានផុតកំណត់។',
  live_ended: 'ការចែករំលែកទីតាំងរបស់អ្នកបេក្ខភាពបានបញ្ចប់។',
  live_shared: (name, until) => `${name} បានចែករំលែកទីតាំង (មានសុពលភាពរហូតដល់ ${until})។`,
  location_saved: 'ទីតាំងត្រូវបានរក្សាទុកទៅក្នុងការបញ្ជាទិញរបស់អ្នក។',
  unsupported_qr_payload: 'ទ្រង់ទ្រាយ QR មិនគាំទ្រ — សូមផ្ញើរូបថត ឯកសារ ឬអក្សរ។',
  payment_received: id => `អរគុណ — បានទទួលការទូទាត់សម្រាប់បញ្ជាទិញ #${String(id).padStart(4,'0')}.`,
  picked_up_notify: id => `បញ្ជាទិញលេខ #${String(id).padStart(4,'0')} ត្រូវបានយក។ 🚀`,
  arrived_notify: id => `ប្ដូរទំនិញរបស់អ្នក #${String(id).padStart(4,'0')} បានមកដល់។`
  ,
  marked_paid: 'បានត្រូវបានកំណត់ជា PAID',
  order_not_found: 'មិនបានរកឃើញការបញ្ជាទិញ',
  no_admin: 'មិនមានអ្នកគ្រប់គ្រង',
  qr_or_order_not_found: 'QR ឬការបញ្ជាទិញមិនជាក់ស្តែង',
  order_no_customer: 'ការបញ្ជាទិញមិនមានអតិថិជន',
  qr_sent: 'QR ត្រូវបានផ្ញើទៅអតិថិជន'
  }
};

function getUserLang(userId) {
  const d = drivers.find(x => x.id === userId);
  if (d && d.lang) return d.lang;
  const c = customers.find(x => x.id === userId);
  if (c && c.lang) return c.lang;
  return 'en';
}

function tFor(userId, key, ...args) {
  const lang = getUserLang(userId) || 'en';
  const m = MESSAGES[lang] && MESSAGES[lang][key];
  if (!m) return (MESSAGES['en'][key] && MESSAGES['en'][key](...args)) || '';
  return typeof m === 'function' ? m(...args) : m;
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      // try reading primary data file; if it's corrupted, fall back to a .bak file
      let raw = fs.readFileSync(DATA_FILE, 'utf8');
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        const bak = DATA_FILE + '.bak';
        if (fs.existsSync(bak)) {
          try {
            raw = fs.readFileSync(bak, 'utf8');
            obj = JSON.parse(raw);
            console.warn(`Primary data file corrupted — loaded from backup: ${bak}`);
          } catch (e2) {
            throw e; // rethrow original parse error
          }
        } else {
          throw e;
        }
      }
      if (obj.orders) { orders.length = 0; Array.prototype.push.apply(orders, obj.orders); }
      if (obj.drivers) { drivers.length = 0; Array.prototype.push.apply(drivers, obj.drivers); }
      if (obj.sessions) { sessions.length = 0; Array.prototype.push.apply(sessions, obj.sessions); }
      if (obj.qrCodes) { qrCodes.length = 0; Array.prototype.push.apply(qrCodes, obj.qrCodes); }
  if (obj.shiftProfiles) { shiftProfiles.length = 0; Array.prototype.push.apply(shiftProfiles, obj.shiftProfiles); }
      if (typeof obj.orderCounter === 'number') orderCounter = obj.orderCounter;
  if (typeof obj.profileCounter === 'number') profileCounter = obj.profileCounter;
      if (obj.SETTINGS) SETTINGS = Object.assign(SETTINGS, obj.SETTINGS);
      // cleanup sessions: remove ended/expired sessions or sessions referencing missing drivers/orders/customers
      try {
        const now = Date.now();
        const beforeCount = sessions.length;
        const valid = sessions.filter(s => {
          if (!s) return false;
          if (s.ended) return false;
          if (s.expiresAt && s.expiresAt <= now) return false;
          // require driver exists
          const drv = drivers.find(d => d.id === s.driverId);
          if (!drv) return false;
          // require order exists
          const ord = orders.find(o => o.order_id === s.orderId);
          if (!ord) return false;
          // if order has customer_id, require customer exists
          if (ord.customer_id) {
            const cust = customers.find(c => c.id === ord.customer_id);
            if (!cust) return false;
          }
          return true;
        });
        if (valid.length !== beforeCount) {
          // replace sessions array content with valid sessions
          sessions.length = 0;
          Array.prototype.push.apply(sessions, valid);
          try { saveData(); } catch (e) { console.error('Failed to save data after session cleanup', e && e.message); }
        }
        // schedule any active sessions (restore both expiry timeout and forwarding interval) // eslint-disable-next-line no-unused-vars
        sessions.forEach(s => {
          if (!s.ended && s.expiresAt && s.expiresAt > Date.now()) {
            scheduleSessionExpiry(s);
            // re-establish periodic forwarding of last known location
            try { scheduleSessionInterval(s); } catch (e) { console.error('Failed to schedule session interval on load', e && e.message); }
          }
        });
      } catch (e) {
        console.error('Session cleanup on load failed', e && e.message);
      }
      console.log('Loaded data from', DATA_FILE);
    }
  } catch (e) {
    try {
      // write a diagnostic dump for debugging corrupt file
      const corruptPath = DATA_FILE + `.corrupt-${Date.now()}.json`;
      try { fs.writeFileSync(corruptPath, fs.readFileSync(DATA_FILE, 'utf8'), 'utf8'); console.error('Failed to load data — corrupt dump written to', corruptPath); } catch (e2) { /* ignore */ }
    } catch (ee) { }
    console.error(`Failed to load data: ${e && e.message}`);
  }
}

function saveData() {
  // queue writes so only one write/rename runs at a time
  const obj = { orders, drivers, customers, sessions, qrCodes, shiftProfiles, orderCounter, profileCounter, SETTINGS };
  const data = JSON.stringify(obj, null, 2);
  const tmp = DATA_FILE + '.tmp';
  const bak = DATA_FILE + '.bak';

  _savePromise = _savePromise.then(() => {
    try {
      // write to temp file first
      fs.writeFileSync(tmp, data, 'utf8');
      // keep a backup of previous good file (best-effort)
      try { if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, bak); } catch (e) { /* ignore backup errors */ }
      // atomic rename
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { // eslint-disable-next-line no-empty
      console.error('Failed to save data:', e && e.message);
      // cleanup temp file if left behind
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { }
    }
  }).catch(e => { console.error('saveData queue failed', e && e.message); });
}

// Read drivers array from disk without mutating in-memory state.
function readDriversFromDisk() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const obj = JSON.parse(raw || '{}');
    return Array.isArray(obj.drivers) ? obj.drivers : [];
  } catch (e) {
    return [];
  }
}


function formatOrder(order) {
  // helpers for HTML-safe output
  function escapeHtml(s) {
    if (!s && s !== 0) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function formatDateShort(ds) {
    if (!ds) return '';
    const d = new Date(ds);
    if (isNaN(d.getTime())) return escapeHtml(ds);
    const day = String(d.getDate()).padStart(2, '0');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mon = months[d.getMonth()];
    const yy = String(d.getFullYear()).slice(-2);
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    return `${day} ${mon}. ${yy} ${hh}:${mm}`;
  }

  const lines = [];
  const statusEmoji = order.order_status_emoji || '🆕';
  const id = String(order.order_id || 0).padStart(4, '0');
  lines.push(`${statusEmoji} #${id}`);

  // customer name: link to open chat when possible
  if (order.customer_id) {
    const name = escapeHtml(order.customer_name || String(order.customer_id));
    lines.push(`👤 <a href="tg://user?id=${order.customer_id}">${name}</a>`);
  } else {
    lines.push(`👤 ${escapeHtml(order.customer_name || '')}`);
  }

  // location: prefer coordinates 'location:lat,lon' -> google maps link; otherwise show map_link as text/link
  let locText = '';
  if (order.map_link && String(order.map_link).startsWith('location:')) {
    const parts = String(order.map_link).replace('location:', '').replace(/\s+/g,'').split(',');
    const lat = parts[0]; const lon = parts[1];
    if (lat && lon) {
      const g = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
      // show a short clickable "map link" label that opens Google Maps
      locText = `<a href="${g}">map link</a>`;
    } else locText = escapeHtml(order.map_link || '');
  } else if (order.map_link && String(order.map_link).match(/https?:\/\//i)) {
    const url = escapeHtml(order.map_link);
    // show a short clickable label instead of the full URL
    locText = `<a href="${url}">map link</a>`;
  } else {
    // free-form location text (codename or instructions) should be shown verbatim
    locText = escapeHtml(order.map_link || order.location || '');
  }
  lines.push(`📍 ${locText}`);

  const total = typeof order.total_amount === 'number' ? `${order.total_amount.toFixed(2)}` : '';
  const paid = order.paid_status ? ` ${escapeHtml(order.paid_status)}` : '';
  const pm = order.payment_method ? ` by ${escapeHtml(order.payment_method)}` : '';
  lines.push(`💲 ${escapeHtml(total)}${paid}${pm}`.trim());
  if (order.payment_method === 'CASH') {
    lines.push(`💰 ${escapeHtml(order.given_cash || '')}`);
    lines.push(`💱 ${typeof order.change_cash !== 'undefined' ? escapeHtml(order.change_cash) : ''}`);
  }

  const driverEmoji = order.driver_assigned ? (order.driver_status === 'busy' ? '🟡' : (order.driver_status === 'assigned' ? '🔵' : '🚀')) : '🚀';
  if (order.driver_id) {
    const dname = escapeHtml(order.driver_name || String(order.driver_id));
    lines.push(`${driverEmoji} <a href="tg://user?id=${order.driver_id}">${dname}</a>`);
  } else {
    lines.push(`${driverEmoji} ${escapeHtml(order.driver_name || '')}`);
  }

  lines.push(`📃 ${escapeHtml(order.items || '')}`);
  if (order.feedback) lines.push(`⭐ ${escapeHtml(order.feedback)}`);
  lines.push(`📅 ${formatDateShort(order.date_time_stamp || '')}`);
  return lines.join('\n');
}

// Utilities: haversine distance in meters and simple ETA estimator
function haversineMeters(lat1, lon1, lat2, lon2) {
  function toRad(v) { return v * Math.PI / 180; }
  const R = 6371000; // meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function estimateETASeconds(distanceMeters, speedKmph = 30) {
  // speed in km/h -> m/s
  const speedMs = (speedKmph * 1000) / 3600;
  if (!speedMs || speedMs <= 0) return null;
  return Math.round(distanceMeters / speedMs);
}

// No external routing by default; drivers get a Google Maps directions link and a simple ETA estimate using haversine distance.

function createOrder(data = {}) {
  const order = Object.assign({
    order_id: orderCounter++,
    order_status: 'new',
    order_status_emoji: '🆕',
    customer_name: '',
    customer_id: null,
    map_link: '',
    total_amount: 0,
    paid_status: '',
    payment_method: '',
  given_cash: null,
  change_cash: null,
    driver_name: '',
    driver_assigned: false,
    driver_status: null,
    items: '',
    feedback: null,
    date_time_stamp: new Date().toISOString()
  }, data);
  orders.push(order);
  // Note: auto-assignment of orders to drivers was intentionally removed.
  // Orders must be sent to drivers explicitly by admin using the 'Go' action.
  saveData();
  return order;
}

// Central helper to update an order field from admin edit flows
function setOrderField(ord, field, value) {
  if (!ord) return;
  if (field === 'total_amount') {
    const v = isNaN(value) ? ord.total_amount : Number(value);
    ord.total_amount = v;
  } else if (field === 'given_cash') {
    const v = isNaN(value) ? ord.given_cash : Number(value);
    ord.given_cash = v;
    ord.change_cash = (typeof ord.total_amount === 'number' && !isNaN(ord.given_cash)) ? (ord.given_cash - ord.total_amount) : null;
  } else {
    ord[field] = value;
  }
  ord._editingBy = null;
  ord._editField = null;
  saveData();
}

// send a temporary admin message (auto-delete after ttl ms)
async function notifyAdmin(text, opts = {}) {
  if (!ADMIN_ID) return console.log('No ADMIN_ID set — would send to admin:', text);
  try {
  // default to HTML and disable previews so formatted order HTML shows as intended
  const merged = Object.assign({ parse_mode: 'HTML', disable_web_page_preview: true }, opts || {});
  return await bot.sendMessage(ADMIN_ID, text, merged);
  } catch (e) { console.error('notifyAdmin persistent send failed', e && e.message); }
}

// driver keyboards (plain labels: CONNECT / LOGOUT) imported from centralized `keyboards.js`
const driverOfflineKeyboard = K.driver.driverOfflineKeyboard;
const driverOnlineKeyboard = K.driver.driverOnlineKeyboard;

// Keyboards
// Admin main menu as a reply keyboard (uses message text buttons to match admin message handler)
// admin main keyboard (centralized)
const adminMainKeyboard = K.admin.adminMainKeyboardFactory(SETTINGS && SETTINGS.emojisMode);

// Helper: send admin main menu and display connected drivers with quick actions
async function sendAdminMenuWithDrivers(adminChatId) {
  // send main reply keyboard first
  try { await bot.sendMessage(adminChatId, 'Admin menu', adminMainKeyboard); } catch (e) { /* ignore */ }
  // list connected drivers (online/assigned/busy)
  const connected = (drivers || []).filter(d => d && d.status && ['online','assigned','busy'].includes(String(d.status)));
  if (!connected || connected.length === 0) {
    try { await bot.sendMessage(adminChatId, 'Connected drivers: (none)'); } catch (e) {}
    return;
  }
  // send a small card per connected driver with inline quick actions
  for (const d of connected) {
    const label = `${d.name || String(d.id)} — ${d.status || ''}`;
    const kb = { reply_markup: { inline_keyboard: [
      [
        { text: '🗨️ CHAT', url: `tg://user?id=${d.id}` },
        { text: '🗺️ TRACK', callback_data: `admin_track:${d.id}` },
        { text: '📊 STATS', callback_data: `admin_drv_stats:${d.id}` }
      ],
      // quick access to orders list for this driver
      [ { text: 'Active orders', callback_data: `admin_drv_orders:active:${d.id}` }, { text: 'Completed orders', callback_data: `admin_drv_orders:completed:${d.id}` } ]
    ] } };
    try { await bot.sendMessage(adminChatId, label, kb); } catch (e) { console.error('Failed send admin driver card', e && e.message); }
  }
}
// Build inline keyboard used in admin order details
function buildAdminOrderKeyboard(ord, editMode = true, backTarget = null) {
  return K.inline.buildAdminOrderKeyboard(ord, editMode, backTarget);
}
// Admin helpers: list orders by section
function ordersBySection(section) {
  if (section === 'ORDERS') return orders.filter(o => ['new', 'new_draft_order', 'new_forwarded_order', 'new_online_order', 'new'].includes(o.order_status));
  if (section === 'ACTIVE') return orders.filter(o => ['assigned', 'pickedup', 'arrived'].includes(o.order_status));
  if (section === 'COMPLETED') return orders.filter(o => ['completed', 'cancelled', 'archived'].includes(o.order_status));
  return [];
}

async function sendOrdersListToAdmin(section) {
    saveData();
  const list = ordersBySection(section);
  if (!ADMIN_ID) return;
  // remove any persistent reply keyboard before showing inline list
  try { await bot.sendMessage(ADMIN_ID, 'Admin menu', { reply_markup: { remove_keyboard: true } }); } catch(e){}
  if (list.length === 0) {
    return bot.sendMessage(ADMIN_ID, `${section}: (no orders)`);
  }
  const buttons = list.map(o => [{ text: `${o.order_status_emoji || '🆕'} #${String(o.order_id).padStart(4,'0')} for ${o.customer_name || ''}`, callback_data: `open:${o.order_id}:${section}` }]);
  // add a final go-back button to return to menu/previous view
  buttons.push([{ text: '⬅️ Go back', callback_data: `back:menu` }]);
  return bot.sendMessage(ADMIN_ID, `${section} — ${list.length} orders`, { reply_markup: { inline_keyboard: buttons } });
}

async function sendOrderDetailsToAdmin(orderId, editMode = true, chatId = null, backTarget = null) {
  const ord = orders.find(o => o.order_id === Number(orderId));
  if (!ord) return;
  const text = formatOrder(ord);
  const targetChat = chatId || ADMIN_ID;
  // remove persistent reply keyboard (if any) then send as HTML with inline keyboard
  try { if (targetChat === ADMIN_ID) await bot.sendMessage(ADMIN_ID, 'Admin menu', { reply_markup: { remove_keyboard: true } }); } catch(e){}
  return bot.sendMessage(targetChat, text, Object.assign(buildAdminOrderKeyboard(ord, editMode, backTarget), { parse_mode: 'HTML', disable_web_page_preview: true }));
}
  saveData();

// Driver helpers
function findAvailableDriver() {
  return drivers.find(d => d.status === 'online');
}

async function sendOrderToDriver(order, driver) {
  if (!driver) return;
  const text = `Order for you:\n${formatOrder(order)}`;
    const readyKeyboard = K.inline.driverReadyKeyboard(order.order_id);
  try {
  await bot.sendMessage(driver.id, text, Object.assign({ parse_mode: 'HTML', disable_web_page_preview: true }, readyKeyboard));
  } catch (e) {
    console.error(`Failed send to driver ${e.message}`);
  }
}

// Live-location session helpers
function startLiveSession(driverId, orderId) {
  // stop existing session for this driver
  const existing = sessions.find(s => s.driverId === driverId && !s.ended);
  if (existing) existing.ended = true;
  const session = { id: `${driverId}:${orderId}:${Date.now()}`, driverId, orderId, startedAt: Date.now(), ended: false, expiresAt: Date.now() + 30 * 60 * 1000, lastLocation: null };
  sessions.push(session);
  saveData();
  // schedule expiry
  scheduleSessionExpiry(session);
  scheduleSessionInterval(session);
  return session;
}

function stopLiveSession(driverId, orderId) {
  const s = sessions.find(ss => ss.driverId === driverId && ss.orderId === orderId && !ss.ended);
  if (s) { s.ended = true; s.endedAt = Date.now(); saveData(); }
  // cancel timer if present
  if (s) cancelSessionTimer(s.id);
  return s;
}

function scheduleSessionExpiry(session) {
  try {
    // cancel existing if any
    // keep existing interval running; only update/replace timeout
    const existing = sessionTimers.get(session.id) || {};
    if (existing.timeout) clearTimeout(existing.timeout);
    const ms = Math.max(0, (session.expiresAt || (Date.now() + 30*60*1000)) - Date.now());
    const t = setTimeout(async () => {
      session.ended = true;
      session.endedAt = Date.now();
      saveData();
      // notify driver and customer
      const drv = drivers.find(d => d.id === session.driverId);
      const ord = orders.find(o => o.order_id === session.orderId);
  try { if (drv) await bot.sendMessage(drv.id, tFor(drv.id, 'live_expired')); } catch(e){}
  try { if (ord && ord.customer_id) await bot.sendMessage(ord.customer_id, tFor(ord.customer_id, 'live_ended')); } catch(e){}
      // clear interval as well
      const cur = sessionTimers.get(session.id);
      if (cur && cur.interval) { clearInterval(cur.interval); }
      sessionTimers.delete(session.id);
    }, ms); // eslint-disable-next-line no-unused-vars
    existing.timeout = t;
    sessionTimers.set(session.id, existing);
  } catch (e) { console.error('scheduleSessionExpiry', e.message); }
}

function scheduleSessionInterval(session) {
  try {
    const existing = sessionTimers.get(session.id) || {};
    if (existing.interval) clearInterval(existing.interval);
    // every 15s forward last known location (if any) to customer while session active
    const iv = setInterval(async () => {
      try {
        if (session.ended) { clearInterval(iv); return; }
        if (!session.lastLocation) return;
        const ord = orders.find(o => o.order_id === session.orderId);
        if (ord && ord.customer_id) {
          await bot.sendLocation(ord.customer_id, session.lastLocation.latitude, session.lastLocation.longitude);
        }
      } catch (e) { /* ignore transient errors */ } // eslint-disable-next-line no-unused-vars
    }, 15 * 1000);
    existing.interval = iv;
    sessionTimers.set(session.id, existing);
  } catch (e) { console.error('scheduleSessionInterval', e.message); }
}

function cancelSessionTimer(sessionId) {
  const entry = sessionTimers.get(sessionId);
  if (entry) {
    if (entry.timeout) clearTimeout(entry.timeout);
    if (entry.interval) clearInterval(entry.interval);
    sessionTimers.delete(sessionId);
  }
}

function getActiveSessionForDriver(driverId) {
  const now = Date.now();
  const s = sessions.find(ss => ss.driverId === driverId && !ss.ended && ss.expiresAt > now);
  return s;
}

// Unified message handler: admin -> driver -> customer
bot.on('message', async (msg) => {
  try {
    // let bot.onText handle slash-commands
    if (msg && msg.text && msg.text.startsWith('/')) return;
    saveData();
    const from = msg.from || {};
    const chatId = msg.chat && msg.chat.id;
  //ADMIN first: handle admin buttons, forwarded messages and edit-mode attachments
    if (chatId === ADMIN_ID) {
      const text = msg.text ? msg.text.trim() : '';
      // admin profile creation state stored temporarily on admin session
      if (!global.adminPendingProfile) global.adminPendingProfile = null;
      // helper to send stats / profiles menu
      async function sendStatsMenu() {
        // build rows: NEW PROFILE + existing profiles
        const rows = [];
        rows.push([{ text: '➕ NEW PROFILE', callback_data: 'stats:new_profile' }]);
        (shiftProfiles || []).forEach(p => {
          rows.push([{ text: `${p.name || 'Profile'} (${p.id})`, callback_data: `stats:open:${p.id}` }]);
        });
        rows.push([{ text: '⬅️ Go back', callback_data: 'back:menu' }]);
        const kb = { reply_markup: { inline_keyboard: rows } };
        await bot.sendMessage(ADMIN_ID, 'Profiles', kb);
      }
      // admin main buttons
      if (text === '📥ORDERS') { await sendOrdersListToAdmin('ORDERS'); return; } // eslint-disable-next-line no-unused-vars
      if (text === '⚡ACTIVE') { await sendOrdersListToAdmin('ACTIVE'); return; }
      if (text === '✅COMPLETED') { await sendOrdersListToAdmin('COMPLETED'); return; }
      if (text === '➕NEW') {
        // create a minimal new order and open for edit (same as /create_new_order)
        const order = createOrder({ customer_name: from.first_name || 'Admin', customer_id: from.id });
        await bot.sendMessage(ADMIN_ID, 'New order created. Opening for edit...');
        await sendOrderDetailsToAdmin(order.order_id, true, ADMIN_ID, 'ORDERS');
        return;
      }
      if (text === '📊STATS') {
  // open stats / shift profiles menu
  await sendStatsMenu();
        return;
      }
        if (text === '⚙️SETTINGS') {
      const kb = K.inline.adminSettingsKeyboard(SETTINGS.archiveDays, Boolean(SETTINGS.emojisMode));
        // show Settings header visibly again
        await bot.sendMessage(ADMIN_ID, 'Settings', kb);
        return;
      }

        // continue profile creation flow if pending
        if (global.adminPendingProfile && global.adminPendingProfile.step) {
          const pending = global.adminPendingProfile;
          if (pending.step === 'name') {
            // admin sent profile name
            pending.name = text || `Profile ${profileCounter}`;
            pending.step = 'pin';
            await bot.sendMessage(ADMIN_ID, 'Send a 4-digit numeric PIN for this profile (will be stored)');
            return;
          }
          if (pending.step === 'pin') {
            const pin = (text || '').trim();
            if (!/^[0-9]{4}$/.test(pin)) {
              await bot.sendMessage(ADMIN_ID, 'PIN must be 4 digits. Send PIN again.');
              return;
            }
            pending.pin = pin;
            pending.step = 'confirm';
            await bot.sendMessage(ADMIN_ID, `Confirm PIN by sending it again to complete creation of profile '${pending.name}'`);
            return;
          }
          if (pending.step === 'confirm') {
            const pin = (text || '').trim();
            if (pin !== pending.pin) {
              // cancel
              global.adminPendingProfile = null;
              await bot.sendMessage(ADMIN_ID, 'PIN confirmation failed — profile creation cancelled.');
              return;
            }
            // create profile
            const profile = { id: profileCounter++, name: pending.name, pin: pending.pin, shifts: [], totalStars: 0, createdAt: Date.now() };
            shiftProfiles.push(profile);
            saveData();
            global.adminPendingProfile = null;
            await bot.sendMessage(ADMIN_ID, `Profile created: ${profile.name} (id:${profile.id})`);
            // show profiles list again
            await (async () => {
              const rows = [];
              rows.push([{ text: '➕ NEW PROFILE', callback_data: 'stats:new_profile' }]);
              (shiftProfiles || []).forEach(p => rows.push([{ text: `${p.name || 'Profile'} (${p.id})`, callback_data: `stats:open:${p.id}` }]));
              rows.push([{ text: '⬅️ Go back', callback_data: 'back:menu' }]);
              await bot.sendMessage(ADMIN_ID, 'Profiles', { reply_markup: { inline_keyboard: rows } });
            })();
            return;
          }
        }

      // forwarded message -> create order
      const fchat = msg.forward_from_chat;
      const fromUser = msg.forward_from;
      if (fchat || fromUser || msg.forward_sender_name) {
        let customerId = null;
        let customerName = '(unknown)';
        if (fromUser && fromUser.id) {
          customerId = fromUser.id;
          customerName = `${fromUser.first_name || ''} ${fromUser.last_name || ''}`.trim();
        } else if (msg.forward_sender_name) {
          customerName = msg.forward_sender_name;
        }
        let mapLink = '';
        if (msg.location) mapLink = `location:${msg.location.latitude},${msg.location.longitude}`;
        else mapLink = (msg.text && msg.text.includes('http')) ? msg.text : (msg.caption || '');
        const items = msg.caption || msg.text || '(forwarded message)';
        const order = createOrder({ customer_name: customerName, customer_id: customerId, map_link: mapLink, items });
        // If only one driver is online, auto-assign
        try {
          const onlineDrivers = drivers.filter(d => d.status === 'online');
          if (onlineDrivers.length === 1) {
            const driver = onlineDrivers[0];
            order.order_status = 'assigned'; order.order_status_emoji = '🛍️'; order.driver_assigned = true;
            order.driver_name = driver.name; order.driver_status = 'assigned'; order.driver_id = driver.id;
            // notify driver
            sendOrderToDriver(order, driver).catch(()=>{});
          }
        } catch(e) { /* ignore */ }
  const kb = K.inline.adminOrderQuickActions(order.order_id); // eslint-disable-next-line no-unused-vars
        try {
          const sent = await bot.sendMessage(ADMIN_ID, `Forwarded order created #${String(order.order_id).padStart(4,'0')} from ${customerName}\nItems: ${items}`, Object.assign(kb, { parse_mode: 'HTML', disable_web_page_preview: true }));
          if (sent && sent.message_id) adminSentMessages.set(sent.message_id, { orderId: order.order_id, type: 'new_order' });
        } catch (e) { await notifyAdmin(`Forwarded order created #${String(order.order_id).padStart(4,'0')} from ${customerName}`, kb); }
        if (!order.customer_id) {
          order._editingBy = ADMIN_ID; order._editField = 'assign_customer';
          saveData();
          await bot.sendMessage(ADMIN_ID, `Order #${String(order.order_id).padStart(4,'0')} has no customer id. Reply with a contact or send /setcustomer <user_id> or /setcustomer @username`);
        }
        return;
      }

      // admin sent a location while editing an order's map_link
      if (msg.location) {
        const last = orders.slice().reverse().find(o => o._editingBy === ADMIN_ID && o._editField === 'map_link');
        if (last) {
          last.map_link = `location:${msg.location.latitude},${msg.location.longitude}`;
          last._editingBy = null; last._editField = null;
          saveData();
          await bot.sendMessage(ADMIN_ID, `Location attached to order #${String(last.order_id).padStart(4,'0')}`);
          await sendOrderDetailsToAdmin(last.order_id, true, ADMIN_ID);
          return;
        }
      }

      // admin $amount edit flows
      if (msg.text && msg.text.startsWith('$')) {
        const val = parseFloat(msg.text.replace('$', '').trim());
        const last = orders.slice().reverse().find(o => o._editingBy === ADMIN_ID);
        if (last && last._editField) {
          if (last._editField === 'total_amount') {
            setOrderField(last, 'total_amount', val);
            await bot.sendMessage(ADMIN_ID, `Total updated: ${last.total_amount}`);
            await sendOrderDetailsToAdmin(last.order_id, true, ADMIN_ID);
            return;
          }
          if (last._editField === 'given_cash') {
            setOrderField(last, 'given_cash', val);
            await bot.sendMessage(ADMIN_ID, `Given cash set: ${last.given_cash} — change: ${last.change_cash}`);
            await sendOrderDetailsToAdmin(last.order_id, true, ADMIN_ID);
            return;
          }
        }
      }

      // admin forwarded contact to set customer
      if (msg.contact) {
        const last = orders.slice().reverse().find(o => o._editingBy === ADMIN_ID);
        if (last) {
          setOrderField(last, 'customer_name', `${msg.contact.first_name || ''} ${msg.contact.last_name || ''}`.trim());
          setOrderField(last, 'customer_id', msg.contact.user_id || null);
          await bot.sendMessage(ADMIN_ID, `Customer updated for order #${String(last.order_id).padStart(4,'0')}`);
          await sendOrderDetailsToAdmin(last.order_id, true, ADMIN_ID);
          return;
        }
      }

      // admin reply with new customer name, items, $amount or map link
      if (msg.text) {
        const text = msg.text.trim();
        // detect last editing order
        const last = orders.slice().reverse().find(o => o._editingBy === ADMIN_ID);
        // helper to test for map link
        const looksLikeUrl = s => /https?:\/\//i.test(s) || /maps\.app\.goo\.gl|google\.com\/maps|location:/i.test(s);
        if (last) {
          // explicit edit field guidance
          if (last._editField === 'customer_name') {
            setOrderField(last, 'customer_name', text);
            await bot.sendMessage(ADMIN_ID, `Customer name updated for order #${String(last.order_id).padStart(4,'0')}`);
            await sendOrderDetailsToAdmin(last.order_id, true, ADMIN_ID);
            return;
          }
          if (last._editField === 'total_amount' || text.startsWith('$')) {
            // parse amount
            const amountText = text.startsWith('$') ? text.replace('$','').trim() : text;
            const val = parseFloat(amountText);
            if (!isNaN(val)) {
              setOrderField(last, 'total_amount', val);
              await bot.sendMessage(ADMIN_ID, `Total updated: ${last.total_amount}`);
              await sendOrderDetailsToAdmin(last.order_id, true, ADMIN_ID);
              return;
            }
          }
          if (last._editField === 'given_cash' || (last._editField === 'total_amount' && text.startsWith('$'))) {
            const val = parseFloat(text.replace('$','').trim());
            if (!isNaN(val)) {
              setOrderField(last, 'given_cash', val);
              await bot.sendMessage(ADMIN_ID, `Given cash set: ${last.given_cash} — change: ${last.change_cash}`);
              await sendOrderDetailsToAdmin(last.order_id, true, ADMIN_ID);
              return;
            }
          }
          // map link or free-form location text: accept any text (URL, codename, instructions)
          if (text) {
            last.map_link = text;
            last._editingBy = null; last._editField = null; saveData();
            await bot.sendMessage(ADMIN_ID, `Location updated for order #${String(last.order_id).padStart(4,'0')}`);
            await sendOrderDetailsToAdmin(last.order_id, true, ADMIN_ID);
            return;
          }
          // if explicitly editing items
          if (last._editField === 'items') {
            // append provided content to existing items (admin requested updated items)
            const newItems = (last.items ? String(last.items).trim() + '\n' : '') + text;
            setOrderField(last, 'items', newItems);
            await bot.sendMessage(ADMIN_ID, `Items updated for order #${String(last.order_id).padStart(4,'0')}`);
            await sendOrderDetailsToAdmin(last.order_id, true, ADMIN_ID);
            return;
          }
        }
        // if not editing, ignore or create new items only when explicitly editing via edititems flow
      }

      // admin pending QR upload
      if (adminPendingQR.has(ADMIN_ID)) {
        const qid = adminPendingQR.get(ADMIN_ID);
        const q = qrCodes.find(x => String(x.id) === String(qid));
        if (q) {
          if (msg.photo && msg.photo.length) {
            const photo = msg.photo[msg.photo.length - 1];
            q.media = { type: 'photo', file_id: photo.file_id };
            await bot.sendMessage(ADMIN_ID, `QR image saved for ${q.code}`);
          } else if (msg.text) {
            q.media = { type: 'text', text: msg.text };
            await bot.sendMessage(ADMIN_ID, `QR text saved for ${q.code}`);
          } else if (msg.document) {
            q.media = { type: 'document', file_id: msg.document.file_id, name: msg.document.file_name };
            await bot.sendMessage(ADMIN_ID, `QR document saved for ${q.code}`);
          } else {
            await bot.sendMessage(ADMIN_ID, tFor(ADMIN_ID, 'unsupported_qr_payload'));
          }
          saveData();
        }
        adminPendingQR.delete(ADMIN_ID);
        return;
      }

      // admin attaching media/text to an order
      const lastAttach = orders.slice().reverse().find(o => o._editingBy === ADMIN_ID && o._editField === 'attach_media');
      if (lastAttach) {
        if (msg.photo && msg.photo.length) {
          const photo = msg.photo[msg.photo.length - 1];
          lastAttach.media = { type: 'photo', file_id: photo.file_id };
          await bot.sendMessage(ADMIN_ID, `Photo attached to order #${String(lastAttach.order_id).padStart(4,'0')}`);
        } else if (msg.document) {
          lastAttach.media = { type: 'document', file_id: msg.document.file_id, name: msg.document.file_name };
          await bot.sendMessage(ADMIN_ID, `Document attached to order #${String(lastAttach.order_id).padStart(4,'0')}`);
        } else if (msg.text) {
          lastAttach.media = { type: 'text', text: msg.text };
          await bot.sendMessage(ADMIN_ID, `Text attached to order #${String(lastAttach.order_id).padStart(4,'0')}`);
        } else {
          await bot.sendMessage(ADMIN_ID, 'Unsupported attachment payload. Send a photo, document, or text.');
        }
        lastAttach._editingBy = null; lastAttach._editField = null;
        saveData();
        await sendOrderDetailsToAdmin(lastAttach.order_id, true, ADMIN_ID);
        return;
      }

      // If none of the admin flows matched, stop further processing (don't fall through to driver/customer)
      return;
    }

    // 2) DRIVER flows
    try {
      if (msg.text) {
        const t = msg.text.trim();
        const drv = drivers.find(d => d.id === from.id);
        if (drv) {
          // driver language toggle via reply keyboard buttons
          if (t === '🇰🇭' || t.toUpperCase() === 'KH' || t.toUpperCase() === 'KHMER') {
            drv.lang = 'kh'; saveData();
            try { await bot.sendMessage(drv.id, 'ភាសា ត្រូវបាន ផ្លាស់ប្ដូរ ទៅ ខ្មែរ 🇰🇭'); } catch (e) {}
            return;
          }
          if (t === 'EN' || t.toUpperCase() === 'ENGLISH') {
            drv.lang = 'en'; saveData();
            try { await bot.sendMessage(drv.id, 'Language set to English'); } catch (e) {}
            return;
          }
          if (t === 'CONNECT') {
            drv.status = 'online';
            try { await bot.sendMessage(msg.chat.id, tFor(from.id, 'now_online'), driverOnlineKeyboard); } catch (e) {}
            await notifyAdmin(`Driver ${drv.name || drv.id} connected`); // eslint-disable-next-line no-unused-vars
            saveData();
            return;
          }
          if (t === 'LOGOUT') {
            drv.status = 'offline';
            try { await bot.sendMessage(msg.chat.id, tFor(from.id, 'now_offline'), driverOfflineKeyboard); } catch (e) {}
            await notifyAdmin(`Driver ${drv.name || drv.id} disconnected`);
            saveData();
            return;
          }
          if (t === '📦MY ORDERS' || t.toLowerCase() === 'my orders') {
            const my = orders.filter(o => o.driver_id === drv.id && ['assigned','pickedup','arrived'].includes(o.order_status));
            if (my.length === 0) await bot.sendMessage(drv.id, 'No active orders');
            else await bot.sendMessage(drv.id, my.map(o => `#${String(o.order_id).padStart(4,'0')} — ${o.order_status}`).join('\n'));
            return;
          }
          if (t === '📊STATS' || t.toLowerCase() === 'stats') {
            const completed = orders.filter(o => o.driver_id === drv.id && o.order_status === 'completed').length;
            const active = orders.filter(o => o.driver_id === drv.id && ['assigned','pickedup','arrived'].includes(o.order_status)).length;
            await bot.sendMessage(drv.id, `Stats: ${completed} completed, ${active} active`);
            return;
          }
          if (t === '⚙️SETTINGS' || t.toLowerCase() === 'settings') {
            await bot.sendMessage(drv.id, 'Driver settings (none configured)');
            return;
          }
        }
      }
    } catch (e) { console.error('driver keyboard handler error', e && e.message); }

    // Driver sending a location message
    if (msg.location) {
      const drv = drivers.find(d => d.id === from.id);
      if (drv) {
        // find active order assigned to this driver
        const ord = orders.find(o => o.driver_id === drv.id && ['assigned', 'pickedup', 'arrived'].includes(o.order_status));
        if (ord && ord.customer_id) {
          // expire sessions
          sessions.forEach(s => { if (!s.ended && s.expiresAt && s.expiresAt < Date.now()) s.ended = true; });
          const active = getActiveSessionForDriver(drv.id);
          if (active) {
            active.lastLocation = { latitude: msg.location.latitude, longitude: msg.location.longitude };
            active.expiresAt = Date.now() + 30 * 60 * 1000;
            scheduleSessionExpiry(active);
            scheduleSessionInterval(active);
            try {
              await bot.sendLocation(ord.customer_id, msg.location.latitude, msg.location.longitude);
              await bot.sendMessage(ord.customer_id, `${drv.name} shared live location (valid until ${new Date(active.expiresAt).toLocaleTimeString()}).`);
            } catch (e) { console.error('Failed forward driver location', e.message); }
            // auto-arrival check // eslint-disable-next-line no-unused-vars
            if (ord.map_link && ord.map_link.startsWith('location:')) {
              const parts = ord.map_link.replace('location:', '').split(',');
              const lat = parseFloat(parts[0]);
              const lon = parseFloat(parts[1]);
              const dist = haversineMeters(msg.location.latitude, msg.location.longitude, lat, lon);
              if (dist <= 40 && ord.order_status !== 'arrived' && ord.order_status !== 'completed') {
                ord.order_status = 'arrived'; ord.order_status_emoji = '🏁';
                saveData();
                try { await bot.sendMessage(ord.customer_id, tFor(drv.id, 'arrived_notify', ord.order_id)); } catch(e){} // eslint-disable-next-line no-empty
                try { await bot.sendMessage(drv.id, `Auto-marked order #${String(ord.order_id).padStart(4,'0')} as arrived (within ${Math.round(dist)}m).`); } catch(e){}
                await notifyAdmin(`Order #${String(ord.order_id).padStart(4,'0')} auto-arrived (driver within ${Math.round(dist)}m).`);
              }
            }
          } else {
            try { await bot.sendMessage(drv.id, tFor(drv.id, 'no_active_live')); } catch (e) {}
          }
          saveData();
        }
        return;
      }
    }

    // 3) CUSTOMER flows and generic handlers
    // If customer sends a location and has a new order, save it
    if (msg.location) {
      const ordCust = orders.slice().reverse().find(o => o.customer_id === from.id && o.order_status === 'new');
      if (ordCust) {
    ordCust.map_link = `location:${msg.location.latitude},${msg.location.longitude}`;
        saveData();
        await bot.sendMessage(msg.chat.id, tFor(msg.from.id, 'location_saved'));
        return;
      }
    }

    // Append text to items for customer's new order (only for customer chats)
    // ignore admin messages here to avoid accidental appends when admin presses buttons
    if (msg.text && msg.chat && msg.chat.type === 'private' && from.id !== ADMIN_ID) {
      const ord = orders.slice().reverse().find(o => o.customer_id === from.id && o.order_status === 'new');
      if (ord) {
        ord.items = (ord.items || '') + (ord.items ? '\n' : '') + (msg.text || '');
        saveData();
        await bot.sendMessage(msg.chat.id, 'Added to order items.');
        return;
      }
    }

    // Customer may send QR proof (photo/document or text). Try to match existing QR entries
    if (msg.chat && msg.chat.type === 'private' && msg.from) {
      const fromId = msg.from.id;
      const ord = orders.slice().reverse().find(o => o.customer_id === fromId && o.payment_method === 'QR' && o.paid_status !== 'PAID');
      if (ord) {
        let matched = null;
        if (msg.photo && msg.photo.length) {
          const photo = msg.photo[msg.photo.length - 1];
          matched = qrCodes.find(q => q.media && q.media.type === 'photo' && q.media.file_id === photo.file_id);
        }
        if (!matched && msg.document) {
          matched = qrCodes.find(q => q.media && q.media.type === 'document' && q.media.file_id === msg.document.file_id);
        }
        if (!matched && msg.text) {
          matched = qrCodes.find(q => (q.media && q.media.type === 'text' && q.media.text && msg.text.includes(q.media.text)) || (msg.text.includes(q.code)) );
        }
        if (matched) {
              ord.paid_status = 'PAID'; ord.payment_method = 'QR';
              saveData();
              await bot.sendMessage(fromId, `Thanks — payment received for order #${String(ord.order_id).padStart(4,'0')}.`);
              if (ord.driver_id) { try { await bot.sendMessage(ord.driver_id, `Order #${String(ord.order_id).padStart(4,'0')} marked PAID by customer.`); } catch (e) {} } // eslint-disable-next-line no-empty
              await notifyAdmin(`Order #${String(ord.order_id).padStart(4,'0')} paid via QR by ${ord.customer_name || fromId}`);
              return;
            }
          }
        }

      } catch (e) { console.error('message handler failed', e && e.message); }
    });

    // Handlers
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  console.log(`[/start] from=${from.id}${from.username ? '(@'+from.username+')' : ''} chat=${chatId} ADMIN_ID=${ADMIN_ID}`);
  // register customer
  if (!customers.find(c => c.id === from.id)) {
    customers.push({ id: from.id, name: `${from.first_name || ''} ${from.last_name || ''}`.trim(), username: from.username });
  }
  // For admin, don't send the regular welcome message — show admin menu only
  if (from.id === ADMIN_ID) {
    // show admin reply keyboard in admin's private chat
    try {
  const sent = await bot.sendMessage(ADMIN_ID, 'Admin menu', adminMainKeyboard);
      console.log(`[start] admin keyboard sent to ${ADMIN_ID} message_id=${sent && sent.message_id}`);
    } catch (e) {
      console.error('[start] Failed to send admin keyboard to ADMIN_ID', e && e.message);
      // fallback: try sending keyboard to invoking chat so admin sees it
      try {
  const sent2 = await bot.sendMessage(chatId, 'Admin menu', adminMainKeyboard);
        console.log(`[start] admin keyboard fallback sent to chat ${chatId} message_id=${sent2 && sent2.message_id}`);
      } catch (e2) { console.error('[start] Failed to send admin keyboard to invoking chat', e2 && e2.message); }
    }
    // acknowledge in the original chat if not the admin private chat
    if (chatId !== ADMIN_ID) {
      try { await bot.sendMessage(chatId, 'Admin menu sent (check your private chat).'); } catch (e) { }
    }
    return;
  }
  // non-admin welcome
  await bot.sendMessage(chatId, tFor(from.id, 'welcome', from.first_name || 'friend'), { reply_markup: { remove_keyboard: true } });
});

bot.onText(/\/register/, async (msg) => {
  const from = msg.from || {};
  if (!drivers.find(d => d.id === from.id)) {
    drivers.push({ id: from.id, name: `${from.first_name || ''} ${from.last_name || ''}`.trim(), username: from.username, status: 'pending' });
  }
  await bot.sendMessage(from.id, tFor(from.id, 'reg_sent'));
  const buttons = K.inline.driverApprovalKeyboard(from.id);
  const sent = await notifyAdmin(`NEW DRIVER ${from.first_name || ''} wants to join.`, buttons);
  // store pending admin message so we can delete it when handled
  if (sent && sent.message_id) {
    driverApprovalMessages.set(String(from.id), { chatId: sent.chat.id || ADMIN_ID, messageId: sent.message_id });
  }
  saveData();
});

// Admin utility: create a new empty order and open it for editing
bot.onText(/\/create_new_order/, async (msg) => {
  // only allow admin to use this command
  if (!msg.chat || msg.chat.id !== ADMIN_ID) return;
  // create a minimal order with admin as the creator (customer_name prefilled)
  const order = createOrder({ customer_name: msg.from.first_name || 'Admin', customer_id: msg.from.id });
  // open the new order in admin view (edit mode)
  await bot.sendMessage(ADMIN_ID, 'New order created. Opening for edit...');
  await sendOrderDetailsToAdmin(order.order_id, true, ADMIN_ID, 'ORDERS');
});

// Admin: set a setting manually: /setsetting key value
bot.onText(/\/setsetting (\S+) (\d+)/, async (msg, match) => {
  if (!msg.chat || msg.chat.id !== ADMIN_ID) return;
  const key = match[1];
  const value = Number(match[2]);
  if (!key || isNaN(value)) return bot.sendMessage(ADMIN_ID, 'Usage: /setsetting <key> <numeric_value>');
  SETTINGS[key] = value;
  saveData();
  await bot.sendMessage(ADMIN_ID, `Setting ${key} set to ${value}`);
});

// Admin utility: fetch a message from the group and show it to admin (usage: /fetchmsg <message_id>)
bot.onText(/\/fetchmsg (\d+)/, async (msg, match) => {
  if (!msg.chat || msg.chat.id !== ADMIN_ID) return;
  const mid = Number(match[1]);
  try {
    // feature disabled: cannot fetch message from configured group — inform admin
    await bot.sendMessage(ADMIN_ID, `Fetch message feature disabled. Please forward the message manually or provide the message id in the group.`);
  } catch (e) {
    await bot.sendMessage(ADMIN_ID, `Failed to notify admin: ${e.message}`);
  }
});

// Clear admin temp UI (delete temp messages and re-show main keyboard)
bot.onText(/\/clear_admin_ui/, async (msg) => {
  if (!msg.chat || msg.chat.id !== ADMIN_ID) return;
  // temp messages feature removed; re-show keyboard without header text
  try { await bot.sendMessage(ADMIN_ID, 'Admin menu', adminMainKeyboard); } catch (e) { /* ignore */ } // eslint-disable-next-line no-empty
});

// Archive command: prompt admin in the group to approve archiving (and log it)
bot.onText(/\/copilot_archive(?:\s+(\d+))?/, async (msg, match) => {
  if (!msg.chat || msg.chat.id !== ADMIN_ID) return;
  // optional order id argument
  const id = match && match[1] ? Number(match[1]) : null;
  const text = id ? `Request to archive order #${String(id).padStart(4,'0')}` : 'Request to archive old orders';
    try {
      // group prompts disabled — send archive request to admin directly
      await bot.sendMessage(ADMIN_ID, `${text}
Request posted for approval by ${msg.from.username || msg.from.first_name || 'admin'}.`);
    } catch (e) {
      await bot.sendMessage(ADMIN_ID, `Failed to notify admin about archive request: ${e.message}`);
    }
});

bot.onText(/\/en/, async (msg) => {
  const u = msg.from || {};
  const drv = drivers.find(d => d.id === u.id);
  if (drv) drv.lang = 'en';
  const c = customers.find(cu => cu.id === u.id);
  if (c) c.lang = 'en';
  saveData();
  await bot.sendMessage(u.id, 'Language set to English');
});

// Admin: set customer for the order in assign_customer mode or by specifying order id
bot.onText(/\/setcustomer (.+)/, async (msg, match) => {
  if (!msg.chat || msg.chat.id !== ADMIN_ID) return;
  const val = (match && match[1]) ? match[1].trim() : null;
  if (!val) return bot.sendMessage(ADMIN_ID, 'Usage: /setcustomer <user_id|@username>');
  // find last order waiting for assignment
  const ord = orders.slice().reverse().find(o => o._editingBy === ADMIN_ID && o._editField === 'assign_customer');
  if (!ord) return bot.sendMessage(ADMIN_ID, 'No order is waiting for customer assignment.');
  let userId = null;
  if (val.startsWith('@')) {
    // try find by username in customers/drivers
    const name = val.replace('@', '');
    const foundCust = customers.find(c => c.username === name);
    if (foundCust) userId = foundCust.id;
    const foundDrv = drivers.find(d => d.username === name);
    if (!userId && foundDrv) userId = foundDrv.id;
    if (!userId) return bot.sendMessage(ADMIN_ID, `Username ${val} not found in known users.`);
  } else {
    userId = Number(val);
    if (isNaN(userId)) return bot.sendMessage(ADMIN_ID, 'Invalid id');
  }
  ord.customer_id = userId;
  ord._editingBy = null; ord._editField = null;
  saveData();
  await bot.sendMessage(ADMIN_ID, `Order #${String(ord.order_id).padStart(4,'0')} assigned to user ${userId}`);
});

// Admin command: set orderCounter to a specific number. Use with care.
// Usage: /setordercounter <number> [force]
bot.onText(/\/setordercounter\s+(\d+)(?:\s+(force))?/i, async (msg, match) => {
  if (!msg.chat || msg.chat.id !== ADMIN_ID) return;
  const requested = Number(match[1]);
  const force = !!match[2];
  if (isNaN(requested) || requested < 1) return bot.sendMessage(ADMIN_ID, 'Usage: /setordercounter <positive_number> [force]');
  // compute max existing order_id to avoid collisions
  const maxId = orders.reduce((m, o) => Math.max(m, Number(o && o.order_id) || 0), 0);
  if (requested <= maxId && !force) {
    return bot.sendMessage(ADMIN_ID, `Refusing to set ${requested} because max existing order_id is ${maxId}. To force this anyway, run: /setordercounter ${requested} force`);
  }
  orderCounter = requested;
  saveData();
  await bot.sendMessage(ADMIN_ID, `orderCounter set to ${String(orderCounter).padStart(6,'0')}${force ? ' (forced)' : ''}`);
});

bot.onText(/\/kh/, async (msg) => {
  const u = msg.from || {};
  const drv = drivers.find(d => d.id === u.id);
  if (drv) drv.lang = 'kh';
  const c = customers.find(cu => cu.id === u.id);
  if (c) c.lang = 'kh';
  saveData();
  await bot.sendMessage(u.id, 'ភាសាត្រូវបានផ្លាស់ប្តូរ');
});

// Removed duplicate generic message handler — unified handler above performs admin -> driver -> customer flows.

// Callback queries (inline buttons)
bot.on('callback_query', async (cb) => {
  const data = cb.data || '';
  const from = cb.from || {};
  // send to driver (go)
  if (data.startsWith('go:')) {
    const id = Number(data.split(':')[1]);
    const ord = orders.find(o => o.order_id === id);
    if (ord) {
      ord.order_status = 'assigned'; ord.order_status_emoji = '🛍️'; ord.driver_assigned = true;
      // auto-assign first available driver
      const driver = findAvailableDriver();
      if (driver) {
        ord.driver_name = driver.name; ord.driver_status = 'assigned'; ord.driver_id = driver.id;
        await sendOrderToDriver(ord, driver);
        await bot.answerCallbackQuery(cb.id, { text: `Order assigned to ${driver.name}` }); // eslint-disable-next-line no-unused-vars
  await notifyAdmin(`Order #${String(id).padStart(4,'0')} assigned to ${driver.name}`);
      } else {
        ord.driver_name = '';
        ord.driver_status = null;
        ord.driver_id = null;
        await bot.answerCallbackQuery(cb.id, { text: 'No available drivers — order kept in queue' });
      }
      saveData();
      try { return await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: cb.message.chat.id, message_id: cb.message.message_id }); } catch (e) { /* ignore */ }
    }
  }

  // start/stop live location sharing by driver
  if (data.startsWith('driver_start_live:')) {
    const id = Number(data.split(':')[1]);
    const drv = drivers.find(d => d.id === from.id);
    const ord = orders.find(o => o.order_id === id);
    if (drv && ord) {
      const s = startLiveSession(drv.id, ord.order_id);
      await bot.answerCallbackQuery(cb.id, { text: tFor(from.id, 'live_started', drv.name, new Date(s.expiresAt).toLocaleTimeString()) });
      if (ord.customer_id) await bot.sendMessage(ord.customer_id, tFor(drv.id, 'live_shared', drv.name, new Date(s.expiresAt).toLocaleTimeString()));
    }
    return;
  }
  if (data.startsWith('driver_stop_live:')) {
    const id = Number(data.split(':')[1]);
    const drv = drivers.find(d => d.id === from.id);
    const ord = orders.find(o => o.order_id === id);
    if (drv && ord) {
      stopLiveSession(drv.id, ord.order_id);
      await bot.answerCallbackQuery(cb.id, { text: tFor(from.id, 'live_stopped', drv.name) });
      if (ord.customer_id) await bot.sendMessage(ord.customer_id, tFor(drv.id, 'live_stopped', drv.name));
    }
    return;
  }

  // emojis mode toggle for admin UI
  if (data === 'settings:emojis') {
    SETTINGS.emojisMode = !Boolean(SETTINGS.emojisMode);
    saveData();
    const kb = K.inline.adminSettingsKeyboard(SETTINGS.archiveDays, Boolean(SETTINGS.emojisMode));
    await bot.answerCallbackQuery(cb.id, { text: `Emojis mode ${SETTINGS.emojisMode ? 'enabled' : 'disabled'}` });
    return bot.sendMessage(ADMIN_ID, 'Settings', kb);
  }

  // Admin stats / shift profiles callbacks
  if (data.startsWith('stats:')) {
    const parts = data.split(':');
    const action = parts[1];
    if (action === 'new_profile') {
      // prompt admin for profile name
      global.adminPendingProfile = { step: 'name' };
      await bot.answerCallbackQuery(cb.id, { text: 'Creating new profile — send profile name now' });
      return bot.sendMessage(ADMIN_ID, 'Please send the new profile name (one line)');
    }
    if (action === 'open') {
      const id = Number(parts[2]);
      const profile = (shiftProfiles || []).find(p => p.id === id);
      if (!profile) { await bot.answerCallbackQuery(cb.id, { text: 'Profile not found' }); return; }
      // show profile dashboard (HTML) with elapsed time for active shift
      const connectedDrivers = (profile.activeShift && profile.activeShift.connectedDrivers) ? profile.activeShift.connectedDrivers.length : 0;
      const totalStars = profile.totalStars || 0;
      let statusLine = 'Not running';
      if (profile.activeShift && profile.activeShift.startedAt) {
        const startedAt = profile.activeShift.startedAt;
        const elapsedMs = Date.now() - startedAt;
        const mins = Math.floor(elapsedMs / 60000);
        const hrs = Math.floor(mins / 60);
        const remMins = mins % 60;
        statusLine = `Started at ${new Date(startedAt).toLocaleString()} (running ${hrs}h ${remMins}m)`;
      }
      const textLine = `<b>📊 PROGRESSION</b> (${escapeHtml(profile.name)})\n${escapeHtml(statusLine)}\n<b>Connected drivers:</b> ${connectedDrivers}\n<b>Total stars:</b> ${totalStars}`;
      const rows = [];
      if (!profile.activeShift) rows.push([{ text: '▶️ Start shift', callback_data: `stats:start:${profile.id}` }]);
      else rows.push([{ text: '⏹️ Close shift', callback_data: `stats:close:${profile.id}` }]);
      rows.push([{ text: '⬅️ Back', callback_data: 'stats:list' }]);
      await bot.answerCallbackQuery(cb.id, { text: 'Opening profile' });
      return bot.sendMessage(ADMIN_ID, textLine, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
    }
    if (action === 'start') {
      const id = Number(parts[2]);
      const profile = (shiftProfiles || []).find(p => p.id === id);
      if (!profile) { await bot.answerCallbackQuery(cb.id, { text: 'Profile not found' }); return; }
      // create activeShift minimal structure
      profile.activeShift = { startedAt: Date.now(), connectedDrivers: [], closedAt: null };
      saveData();
      await bot.answerCallbackQuery(cb.id, { text: 'Shift started' });
      return bot.sendMessage(ADMIN_ID, `Shift started for ${profile.name}`);
    }
    if (action === 'close') {
      const id = Number(parts[2]);
      const profile = (shiftProfiles || []).find(p => p.id === id);
      if (!profile) { await bot.answerCallbackQuery(cb.id, { text: 'Profile not found' }); return; }
      if (!profile.activeShift) { await bot.answerCallbackQuery(cb.id, { text: 'No active shift' }); return; }
      // close shift: record closedAt and push to profile.shifts history
      const shiftRec = Object.assign({}, profile.activeShift, { closedAt: Date.now() });
      profile.shifts = profile.shifts || [];
      profile.shifts.push(shiftRec);
      // clear active shift
      profile.activeShift = null;
      saveData();
      await bot.answerCallbackQuery(cb.id, { text: 'Shift closed and saved' });
      return bot.sendMessage(ADMIN_ID, `Shift for ${profile.name} closed and saved.`);
    }
    if (action === 'list') {
      // re-show profiles list
      const rows = [];
      rows.push([{ text: '➕ NEW PROFILE', callback_data: 'stats:new_profile' }]);
      (shiftProfiles || []).forEach(p => rows.push([{ text: `${p.name || 'Profile'} (${p.id})`, callback_data: `stats:open:${p.id}` }]));
      rows.push([{ text: '⬅️ Go back', callback_data: 'back:menu' }]);
      await bot.answerCallbackQuery(cb.id, { text: 'Profiles' });
      return bot.sendMessage(ADMIN_ID, 'Profiles', { reply_markup: { inline_keyboard: rows } });
    }
  }

  // driver language switch (callback style)
  if (data.startsWith('driver_lang:')) {
    const lang = data.split(':')[1] || 'EN';
    const drv = drivers.find(d => d.id === from.id);
    if (drv) { drv.lang = String(lang).toLowerCase(); saveData(); }
    await bot.answerCallbackQuery(cb.id, { text: `Language set to ${lang}` });
    return;
  }

  // driver approval flows
  if (data.startsWith('drv_approve:')) {
    const id = Number(data.split(':')[1]);
    const drv = drivers.find(d => d.id === id);
    if (drv) {
      drv.status = 'offline';
      await bot.answerCallbackQuery(cb.id, { text: 'Driver approved' });
      // notify driver and present CONNECT keyboard
      try { await bot.sendMessage(id, tFor(id, 'reg_approved'), driverOfflineKeyboard); } catch (e) { console.error('Failed notify driver', e.message); }
      // If there was an admin approval prompt message for this driver, delete it
      const pending = driverApprovalMessages.get(String(id));
      if (pending) {
        try { await bot.deleteMessage(pending.chatId, pending.messageId); } catch (e) { }
        driverApprovalMessages.delete(String(id));
      }
      saveData();
    }
  }

  // Admin actions: open order, set payment, mark paid, set total, cancel, back
  // Admin main menu (inline buttons)
  if (data.startsWith('menu:')) {
    const part = data.split(':')[1];
    await bot.answerCallbackQuery(cb.id, { text: 'OK' });
    if (part === 'orders') { await sendOrdersListToAdmin('ORDERS'); return; }
    if (part === 'active') { await sendOrdersListToAdmin('ACTIVE'); return; }
    if (part === 'completed') { await sendOrdersListToAdmin('COMPLETED'); return; }
    if (part === 'new') {
      const order = createOrder({ customer_name: cb.from.first_name || 'Admin', customer_id: cb.from.id });
      // If exactly one driver is currently online, prefill driver's name for admin convenience
      try {
        const diskDrivers = readDriversFromDisk();
        const onlineDrivers = diskDrivers.filter(d => d.status === 'online');
        if (onlineDrivers.length === 1) {
          order.driver_name = onlineDrivers[0].name || '';
        }
      } catch (e) { /* ignore */ }
      await bot.sendMessage(ADMIN_ID, 'New order created. Opening for edit...');
      await sendOrderDetailsToAdmin(order.order_id, true, ADMIN_ID, 'ORDERS');
      return;
    }
    if (part === 'stats') {
      const total = orders.length;
      const active = orders.filter(o => ['assigned','pickedup','arrived'].includes(o.order_status)).length;
      const completed = orders.filter(o => ['completed','cancelled','archived'].includes(o.order_status)).length;
      const pendingDrivers = drivers.filter(d => d.status === 'pending').length;
      await bot.sendMessage(ADMIN_ID, `Stats\nTotal orders: ${total}\nActive: ${active}\nCompleted/archived: ${completed}\nDrivers pending: ${pendingDrivers}`);
      return;
    }
    if (part === 'settings') {
      const kb = K.inline.adminSettingsKeyboard(SETTINGS.archiveDays, Boolean(SETTINGS.emojisMode));
      await bot.sendMessage(ADMIN_ID, 'Settings', kb);
      return;
    }
  }

  if (data.startsWith('open:')) {
    const parts = data.split(':');
    const id = Number(parts[1]);
    const section = parts[2] || null;
    const ord = orders.find(o => o.order_id === id);
    if (ord) {
      ord._editingBy = ADMIN_ID;
      ord._editField = null;
      await bot.answerCallbackQuery(cb.id, { text: 'Opening order in edit mode' });
      await sendOrderDetailsToAdmin(id, true, ADMIN_ID, section);
    }
    return;
  }
  if (data.startsWith('setpay:')) {
    const parts = data.split(':');
    const method = parts[1];
    const id = Number(parts[2]);
    const ord = orders.find(o => o.order_id === id);
    if (ord) {
      ord.payment_method = method;
      if (method === 'CASH') {
        ord.given_cash = null;
        ord.change_cash = null;
        ord._editingBy = ADMIN_ID;
        ord._editField = 'given_cash';
        await bot.answerCallbackQuery(cb.id, { text: 'Payment method set to CASH — send $amount to set given cash' });
        await bot.sendMessage(ADMIN_ID, `Send $<amount> to set given cash for order #${String(id).padStart(4,'0')}`);
      } else {
        ord._editingBy = null;
        ord._editField = null;
        await bot.answerCallbackQuery(cb.id, { text: `Payment method set to ${method}` });
      }
  saveData(); // eslint-disable-next-line no-unused-vars
  await sendOrderDetailsToAdmin(id, true, ADMIN_ID);
    }
    return;
  }
  if (data.startsWith('setpaid:')) {
    const parts = data.split(':');
    const id = Number(parts[1]);
    const ord = orders.find(o => o.order_id === id);
    if (ord) {
      ord.paid_status = 'PAID';
      await bot.answerCallbackQuery(cb.id, { text: tFor(ADMIN_ID, 'marked_paid') || 'Marked as PAID' });
  saveData(); // eslint-disable-next-line no-unused-vars
  await sendOrderDetailsToAdmin(id, true, ADMIN_ID);
    }
    return;
  }
  if (data.startsWith('settotal:')) {
    const parts = data.split(':');
    const id = Number(parts[1]);
    const ord = orders.find(o => o.order_id === id);
    if (ord) {
      ord._editingBy = ADMIN_ID;
      ord._editField = 'total_amount';
      await bot.answerCallbackQuery(cb.id, { text: 'Send $<amount> as a message to set the total' });
      await bot.sendMessage(ADMIN_ID, `Please send the new total as $<amount> to update order #${String(id).padStart(4,'0')}`);
    }
    return;
  }
  // admin set location for order
  if (data.startsWith('setloc:')) {
    const id = Number(data.split(':')[1]);
    const ord = orders.find(o => o.order_id === id);
    if (!ord) return await bot.answerCallbackQuery(cb.id, { text: 'Order not found' });
    ord._editingBy = ADMIN_ID; ord._editField = 'map_link';
    await bot.answerCallbackQuery(cb.id, { text: 'Please send a location now (use Telegram location attachment).' });
    await bot.sendMessage(ADMIN_ID, `Send location to attach to order #${String(id).padStart(4,'0')}`);
    saveData();
    return;
  }
  // admin attach media (photo/document/text) to order
  if (data.startsWith('attach:')) {
    const id = Number(data.split(':')[1]);
    const ord = orders.find(o => o.order_id === id);
    if (!ord) return await bot.answerCallbackQuery(cb.id, { text: 'Order not found' });
    ord._editingBy = ADMIN_ID; ord._editField = 'attach_media';
    await bot.answerCallbackQuery(cb.id, { text: 'Please send photo/document or text to attach to the order.' });
    await bot.sendMessage(ADMIN_ID, `Send photo, document or text to attach to order #${String(id).padStart(4,'0')}`);
    saveData();
    return;
  }
  // admin edit customer name
  if (data.startsWith('editcust:')) {
    const id = Number(data.split(':')[1]);
    const ord = orders.find(o => o.order_id === id);
    if (!ord) return await bot.answerCallbackQuery(cb.id, { text: 'Order not found' });
    ord._editingBy = ADMIN_ID; ord._editField = 'customer_name';
    await bot.answerCallbackQuery(cb.id, { text: 'Reply with the new customer name or forward a contact.' });
    await bot.sendMessage(ADMIN_ID, `Please reply with the new customer name for order #${String(id).padStart(4,'0')}`);
    saveData();
    return;
  }
  // admin edit items
  if (data.startsWith('edititems:')) {
    const id = Number(data.split(':')[1]);
    const ord = orders.find(o => o.order_id === id);
    if (!ord) return await bot.answerCallbackQuery(cb.id, { text: 'Order not found' });
    ord._editingBy = ADMIN_ID; ord._editField = 'items';
    await bot.answerCallbackQuery(cb.id, { text: 'Reply with the updated items text.' });
    await bot.sendMessage(ADMIN_ID, `Please send the updated items for order #${String(id).padStart(4,'0')}`);
    saveData();
    return;
  }
  // admin wants to pick a QR to send for an order
  if (data.startsWith('sendqr:')) {
    const id = Number(data.split(':')[1]);
    const ord = orders.find(o => o.order_id === id);
  if (!ord) return await bot.answerCallbackQuery(cb.id, { text: tFor(from.id, 'order_not_found') || 'Order not found' });
  if (!ADMIN_ID) return await bot.answerCallbackQuery(cb.id, { text: tFor(from.id, 'no_admin') || 'No admin set' });
    const rows = qrCodes.map(q => [{ text: `${q.enabled ? '✅' : '⬜'} ${q.code}`, callback_data: `qr:send:${q.id}:${id}` }]);
    rows.push([{ text: 'Cancel', callback_data: 'back:menu' }]);
    await bot.answerCallbackQuery(cb.id, { text: 'Choose QR to send' });
  return bot.sendMessage(ADMIN_ID, `Send which QR to order #${String(id).padStart(4,'0')}?`, K.inline.sendQrToOrderKeyboard(id, qrCodes));
  }

  // send the chosen QR to the customer and mark order.payment_method=QR
  if (data.startsWith('qr:send:')) {
    const parts = data.split(':');
    const qid = parts[1];
    const id = Number(parts[2]);
    const q = qrCodes.find(x => String(x.id) === String(qid));
    const ord = orders.find(o => o.order_id === id);
  if (!q || !ord) return await bot.answerCallbackQuery(cb.id, { text: tFor(from.id, 'qr_or_order_not_found') || 'QR or order not found' });
  if (!ord.customer_id) return await bot.answerCallbackQuery(cb.id, { text: tFor(from.id, 'order_no_customer') || 'Order has no customer' });
    // send media/text depending on q.media
    try {
      if (q.media && q.media.type === 'photo') {
        await bot.sendPhoto(ord.customer_id, q.media.file_id, { caption: `Use this QR to pay for order #${String(id).padStart(4,'0')}` });
      } else if (q.media && q.media.type === 'document') {
        await bot.sendDocument(ord.customer_id, q.media.file_id, {}, { caption: `Use this QR to pay for order #${String(id).padStart(4,'0')}` });
      } else if (q.media && q.media.type === 'text') {
        await bot.sendMessage(ord.customer_id, `QR code: ${q.media.text}\nUse this to pay for order #${String(id).padStart(4,'0')}`);
      } else {
        await bot.sendMessage(ord.customer_id, `QR code: ${q.code}\nUse this to pay for order #${String(id).padStart(4,'0')}`);
      }
      ord.payment_method = 'QR';
  saveData();
  await bot.answerCallbackQuery(cb.id, { text: tFor(ADMIN_ID, 'qr_sent') || `QR sent to customer` }); // eslint-disable-next-line no-unused-vars
  await bot.sendMessage(ADMIN_ID, `QR ${q.code} sent to ${ord.customer_name || 'customer'}`);
    } catch (e) {
      console.error('Failed send QR to customer', e.message);
      await bot.answerCallbackQuery(cb.id, { text: 'Failed to send QR' });
    }
    return;
  }
  if (data.startsWith('cancel:')) {
    const parts = data.split(':');
    const id = Number(parts[1]);
    const ord = orders.find(o => o.order_id === id);
    if (ord) {
      ord.order_status = 'cancelled'; ord.order_status_emoji = '❌';
      ord._editingBy = null; ord._editField = null;
      await bot.answerCallbackQuery(cb.id, { text: 'Order cancelled' }); // eslint-disable-next-line no-unused-vars
  saveData();
  await sendOrderDetailsToAdmin(id, false, ADMIN_ID);
    }
    return;
  }
  if (data.startsWith('back:')) {
    // back:<target> - if target is a known section, reopen that list, otherwise show admin menu
    const parts = data.split(':');
    const target = parts[1] || 'menu';
    await bot.answerCallbackQuery(cb.id, { text: 'Back' });
    if (['ORDERS','ACTIVE','COMPLETED'].includes(target)) {
      await sendOrdersListToAdmin(target);
    } else {
  // show admin inline menu without visible header text // eslint-disable-next-line no-empty
  try { await bot.sendMessage(ADMIN_ID, 'Admin menu', adminMainKeyboard); } catch (e) { /* ignore */ } // eslint-disable-next-line no-unused-vars
    }
    return;
  }
    // Driver actions
    if (data.startsWith('driver_pickup:')) {
      const id = Number(data.split(':')[1]);
      const ord = orders.find(o => o.order_id === id);
      const drv = drivers.find(d => d.id === from.id);
      if (ord && drv) {
    ord.order_status = 'pickedup'; ord.order_status_emoji = '⚡'; ord.driver_status = 'busy'; ord.driver_id = drv.id;
        await bot.answerCallbackQuery(cb.id, { text: 'You picked up the order' });
        // notify customer // eslint-disable-next-line no-unused-vars
  if (ord.customer_id) await bot.sendMessage(ord.customer_id, `Your order #${String(id).padStart(4,'0')} has been picked up. Your driver ${drv.name} is on the way.`, K.inline.etaKeyboard(id));
        // send driver active keyboard
  try { await bot.sendMessage(drv.id, 'Order active', K.inline.driverActiveOrderKeyboard(id)); } catch(e){}
    saveData();
      }
      return;
    }
    if (data.startsWith('driver_route:')) {
      const id = Number(data.split(':')[1]);
      const ord = orders.find(o => o.order_id === id);
      if (ord) {
        // compute ETA using driver's active session location and order.map_link if containing coords
        await bot.answerCallbackQuery(cb.id, { text: 'Route preview' });
        let distanceText = 'N/A';
        let etaText = 'N/A';
        const drv = drivers.find(d => d.id === cb.from.id);
        const session = getActiveSessionForDriver(cb.from.id);
        let distance = null;
        let etaSec = null;
        if (ord.map_link && ord.map_link.startsWith('location:')) {
          const parts = ord.map_link.replace('location:', '').replace(/\s+/g,'').split(',');
          const lat = parseFloat(parts[0]);
          const lon = parseFloat(parts[1]);
          let originLat = null, originLon = null;
          if (session && session.lastLocation) { originLat = session.lastLocation.latitude; originLon = session.lastLocation.longitude; }
          else if (drv && drv.lastKnown) { originLat = drv.lastKnown.latitude; originLon = drv.lastKnown.longitude; }
          if (originLat !== null && originLon !== null) {
            distance = haversineMeters(originLat, originLon, lat, lon);
            etaSec = estimateETASeconds(distance, 30);
            distanceText = `${Math.round(distance)} m`;
            if (etaSec !== null) etaText = `${Math.round(etaSec/60)} min`;
            // construct a Google Maps directions link for driver convenience
            const gLink = `https://www.google.com/maps/dir/?api=1&origin=${originLat},${originLon}&destination=${lat},${lon}&travelmode=driving`;
            try {
              await bot.sendMessage(cb.from.id, `🛵 Route preview:\nDistance: ${distanceText}\nETA: ${etaText}`, K.inline.openInMapsKeyboard(gLink));
            } catch (e) {} // eslint-disable-next-line no-empty
            return;
          }
        }
        try { await bot.sendMessage(cb.from.id, `🛵 Route preview:\nDistance: ${distanceText}\nETA: ${etaText}`); } catch (e) {}
      }
      return;
    }
    if (data.startsWith('driver_arrived:')) {
      const id = Number(data.split(':')[1]);
      const ord = orders.find(o => o.order_id === id);
      const drv = drivers.find(d => d.id === from.id);
      if (ord) {
    ord.order_status = 'arrived'; ord.order_status_emoji = '🏁';
    // stop any live session for this driver/order
    try { stopLiveSession(from.id, id); } catch (e) {}
    await bot.answerCallbackQuery(cb.id, { text: 'Marked as arrived' });
  if (ord.customer_id) await bot.sendMessage(ord.customer_id, `Hi, here's ${drv ? drv.name : 'your driver'}, I'm just arrived at your place, please come to get your meal`, K.inline.customerOkKeyboard(id)); // eslint-disable-next-line no-unused-vars
      }
      return;
    }
    if (data.startsWith('driver_location:')) {
      const id = Number(data.split(':')[1]);
      const drv = drivers.find(d => d.id === from.id);
      const ord = orders.find(o => o.order_id === id);
      if (ord && ord.customer_id) {
        await bot.answerCallbackQuery(cb.id, { text: 'Please send your live location now (use Telegram location attachment)' });
        // note: driver will send a location message which is handled by the 'location' event below
      }
      return;
    }
    if (data.startsWith('driver_delay:')) {
      const id = Number(data.split(':')[1]);
      const drv = drivers.find(d => d.id === from.id);
      if (drv) {
        await bot.answerCallbackQuery(cb.id, { text: 'Select delay' });
  try { await bot.sendMessage(drv.id, 'Select delay: 2mn, 5mn, +10mn', K.inline.delayOptionsKeyboard(id)); } catch(e){}
      } // eslint-disable-next-line no-unused-vars
      return;
    }
    if (data.startsWith('delay:')) {
      const parts = data.split(':');
      const mins = parts[1];
      const id = Number(parts[2]);
      const ord = orders.find(o => o.order_id === id);
      const drv = drivers.find(d => d.id === from.id);
      if (ord && drv) {
        if (ord.customer_id) await bot.sendMessage(ord.customer_id, `Hi, here's ${drv.name}, I am ${mins} minutes away.`);
        await bot.answerCallbackQuery(cb.id, { text: `Delay message sent (${mins}mn)` });
      }
      return;
    }
    // delete an order (admin confirmation)
    if (data.startsWith('delete:')) {
      const id = Number(data.split(':')[1]);
      const idx = orders.findIndex(o => o.order_id === id);
      if (idx === -1) {
        await bot.answerCallbackQuery(cb.id, { text: 'Order not found' });
        return;
      }
      const removed = orders.splice(idx, 1)[0];
      saveData();
      await bot.answerCallbackQuery(cb.id, { text: `Deleted order #${String(id).padStart(4,'0')}` }); // eslint-disable-next-line no-unused-vars
      try { await bot.sendMessage(ADMIN_ID, `Order #${String(id).padStart(4,'0')} deleted.`); } catch (e) { /* ignore */ }
      return;
    }
    // navigation in completed list
    if (data.startsWith('nav:')) {
      const parts = data.split(':');
      const dir = parts[1];
      const id = Number(parts[2]);
      const completed = ordersBySection('COMPLETED');
      const idx = completed.findIndex(o => o.order_id === id);
      if (idx === -1) return await bot.answerCallbackQuery(cb.id, { text: 'Not found in completed list' });
      let nextIdx = idx;
      if (dir === 'prev') nextIdx = Math.max(0, idx - 1);
      if (dir === 'next') nextIdx = Math.min(completed.length - 1, idx + 1);
      const nextOrder = completed[nextIdx];
      if (nextOrder) {
        await bot.answerCallbackQuery(cb.id, { text: 'Opening order' });
        await sendOrderDetailsToAdmin(nextOrder.order_id, false, ADMIN_ID);
      }
      return;
    }

    // admin settings and QR management
    if (data === 'settings:open') {
      await bot.answerCallbackQuery(cb.id, { text: 'Settings' });
  const kb = K.inline.adminSettingsKeyboard(SETTINGS.archiveDays, Boolean(SETTINGS.emojisMode));
      return bot.sendMessage(ADMIN_ID, 'Settings', kb);
    }
  // rotation UI removed — present only archive options and QR management // eslint-disable-next-line no-unused-vars
      
      if (data === 'settings:archive') {
        await bot.answerCallbackQuery(cb.id, { text: 'Archive days' });
        const rows = [
          [{ text: '7d', callback_data: 'settings:set:archiveDays:7' }, { text: '14d', callback_data: 'settings:set:archiveDays:14' }],
          [{ text: '30d', callback_data: 'settings:set:archiveDays:30' }, { text: '⬅️ Go back', callback_data: 'back:menu' }]
        ];
  return bot.sendMessage(ADMIN_ID, `Current archive days: ${SETTINGS.archiveDays}`, K.inline.archiveDaysKeyboard(SETTINGS.archiveDays));
      }
      if (data.startsWith('settings:set:')) {
        const parts = data.split(':');
        const key = parts[2];
        const val = Number(parts[3]);
        if (key && !isNaN(val)) {
          SETTINGS[key] = val;
          saveData();
          await bot.answerCallbackQuery(cb.id, { text: `Set ${key} = ${val}` });
          return bot.sendMessage(ADMIN_ID, `Updated ${key} to ${val}`);
        }
      }
    if (data === 'settings:qr') {
      await bot.answerCallbackQuery(cb.id, { text: 'QR management' });
      const rows = qrCodes.map(q => [{ text: `${q.enabled ? '✅' : '⬜'} ${q.code}`, callback_data: `qr:toggle:${q.id}` }, { text: '⚙️', callback_data: `qr:opts:${q.id}` }]);
      rows.push([{ text: '➕ Add QR', callback_data: 'qr:add' }, { text: '⬅️ Back', callback_data: 'back:menu' }]);
  return bot.sendMessage(ADMIN_ID, 'QR Codes', K.inline.qrCodesListKeyboard(qrCodes));
    }
    if (data.startsWith('qr:opts:')) {
      const id = data.split(':')[2] || data.split(':')[1];
      const q = qrCodes.find(x => String(x.id) === String(id));
      if (!q) return await bot.answerCallbackQuery(cb.id, { text: 'QR not found' });
  const kb = K.inline.qrOptionsKeyboard(q);
      await bot.answerCallbackQuery(cb.id, { text: 'QR options' });
      return bot.sendMessage(ADMIN_ID, `Options for ${q.code}`, kb);
    }
    if (data.startsWith('qr:preview:')) {
      const id = data.split(':')[2] || data.split(':')[1];
      const q = qrCodes.find(x => String(x.id) === String(id));
      if (!q) return await bot.answerCallbackQuery(cb.id, { text: 'QR not found' });
      await bot.answerCallbackQuery(cb.id, { text: 'Previewing QR' });
      try {
        if (q.media && q.media.type === 'photo') {
          return await bot.sendPhoto(ADMIN_ID, q.media.file_id, { caption: `Preview ${q.code}` });
        }
        if (q.media && q.media.type === 'document') {
          return await bot.sendDocument(ADMIN_ID, q.media.file_id, {}, { caption: `Preview ${q.code}` });
        }
        if (q.media && q.media.type === 'text') { // eslint-disable-next-line no-unused-vars
          return await bot.sendMessage(ADMIN_ID, `QR text for ${q.code}:\n${q.media.text}`);
        }
        return await bot.sendMessage(ADMIN_ID, `QR code: ${q.code}`);
      } catch (e) { return await bot.sendMessage(ADMIN_ID, `Failed to preview: ${e.message}`); }
    }
    if (data.startsWith('qr:del:')) {
      const id = data.split(':')[2] || data.split(':')[1];
      const idx = qrCodes.findIndex(x => String(x.id) === String(id));
      if (idx === -1) return await bot.answerCallbackQuery(cb.id, { text: 'QR not found' });
      const removed = qrCodes.splice(idx, 1)[0];
      saveData(); // eslint-disable-next-line no-unused-vars
      await bot.answerCallbackQuery(cb.id, { text: `Deleted ${removed.code}` });
      return bot.sendMessage(ADMIN_ID, `Deleted QR ${removed.code}`);
    }
    if (data.startsWith('qr:toggle:')) {
      const id = data.split(':')[2];
      const q = qrCodes.find(x => String(x.id) === String(id));
      if (q) { q.enabled = !q.enabled; saveData(); await bot.answerCallbackQuery(cb.id, { text: `QR ${q.code} set ${q.enabled ? 'enabled' : 'disabled'}` }); }
      return;
    }
    if (data === 'qr:add') {
  // mark admin as pending to upload a QR (next media/text will attach)
  const newQ = { id: `${Date.now()}`, code: `QR-${Date.now()}`, enabled: true, createdAt: Date.now(), media: null };
  qrCodes.push(newQ); saveData(); // eslint-disable-next-line no-unused-vars
  adminPendingQR.set(ADMIN_ID, newQ.id);
  await bot.answerCallbackQuery(cb.id, { text: 'Send the QR image or code text now (as a photo or message).' });
  return await bot.sendMessage(ADMIN_ID, `Please send the QR image or code text for ${newQ.code}.`);
    }
    // feedback handling
    if (data.startsWith('fb:')) {
      const parts = data.split(':');
      const note = Number(parts[1]);
      const id = Number(parts[2]);
      const ord = orders.find(o => o.order_id === id);
      if (ord) {
        ord.feedback = note;
        await bot.answerCallbackQuery(cb.id, { text: `Thanks for your ${note}⭐` });
        saveData();
        if (ord.driver_name) {
          const drv = drivers.find(d => d.name === ord.driver_name);
          if (drv) {
            try { await bot.sendMessage(drv.id, `${ord.customer_name || 'Customer'} gave you ${note}⭐`); } catch (e) { /* ignore */ }
          } // eslint-disable-next-line no-unused-vars
        }
        await notifyAdmin(`Feedback: ${note} for order #${String(id).padStart(4,'0')}`);
      }
      return;
    }
    // archive approvals from group prompt
    if (data.startsWith('archive_approve:')) {
      const parts = data.split(':');
      const id = Number(parts[1]) || 0;
      await bot.answerCallbackQuery(cb.id, { text: 'Archive approved' });
      // delete the prompt message in the group (cb.message)
      try { await bot.deleteMessage(cb.message.chat.id, cb.message.message_id); } catch (e) {} // eslint-disable-next-line no-empty
      if (id && id > 0) {
        const ord = orders.find(o => o.order_id === id);
        if (ord) { ord.order_status = 'archived'; saveData(); await bot.sendMessage(ADMIN_ID, `Order #${String(id).padStart(4,'0')} archived.`); }
      } else {
        // archive orders older than 7 days
        const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
        let n = 0;
        orders.forEach(o => { if (new Date(o.date_time_stamp).getTime() < cutoff && o.order_status !== 'archived') { o.order_status = 'archived'; n++; } });
        saveData();
        await bot.sendMessage(ADMIN_ID, `Archived ${n} orders older than 7 days.`);
      }
      return;
    }
    if (data.startsWith('archive_reject:')) {
      await bot.answerCallbackQuery(cb.id, { text: 'Archive rejected' });
      try { await bot.deleteMessage(cb.message.chat.id, cb.message.message_id); } catch (e) {} // eslint-disable-next-line no-empty
      await bot.sendMessage(ADMIN_ID, 'Archive rejected by group');
      return;
    }
});


// Simple lifecycle commands for driver to connect/disconnect/pickup/arrive/complete
bot.onText(/\/connect/, async (msg) => {
  const drv = drivers.find(d => d.id === msg.from.id);
  if (!drv) return bot.sendMessage(msg.chat.id, 'You are not registered. Use /register');
  drv.status = 'online';
  // present online keyboard
  try { await bot.sendMessage(msg.chat.id, tFor(msg.from.id, 'now_online'), driverOnlineKeyboard); } catch (e) { } // eslint-disable-next-line no-empty
  // notify admin briefly
  await notifyAdmin(`Driver ${drv.name || drv.id} connected`);
  saveData();
});

bot.onText(/\/disconnect/, async (msg) => {
  const drv = drivers.find(d => d.id === msg.from.id);
  if (!drv) return bot.sendMessage(msg.chat.id, 'You are not registered. Use /register');
  drv.status = 'offline';
  try { await bot.sendMessage(msg.chat.id, tFor(msg.from.id, 'now_offline'), driverOfflineKeyboard); } catch (e) { } // eslint-disable-next-line no-empty
  await notifyAdmin(`Driver ${drv.name || drv.id} disconnected`);
  saveData();
});

// Pickup/arrived/completed for driver using simple text commands for now
bot.onText(/\/pickup (\d+)/, async (msg, match) => {
  const id = Number(match[1]);
  const ord = orders.find(o => o.order_id === id);
  if (!ord) return bot.sendMessage(msg.chat.id, 'Order not found');
  ord.order_status = 'pickedup'; ord.order_status_emoji = '⚡'; ord.driver_status = 'busy';
  await bot.sendMessage(msg.chat.id, `Picked up order #${String(id).padStart(4,'0')}`);
  // notify customer if available
  if (ord.customer_id) await bot.sendMessage(ord.customer_id, `Your order #${String(id).padStart(4,'0')} has been picked up. 🚀`); // eslint-disable-next-line no-unused-vars
  saveData();
});

bot.onText(/\/arrived (\d+)/, async (msg, match) => {
  const id = Number(match[1]);
  const ord = orders.find(o => o.order_id === id);
  if (!ord) return bot.sendMessage(msg.chat.id, 'Order not found');
  ord.order_status = 'arrived'; ord.order_status_emoji = '🏁';
  await bot.sendMessage(msg.chat.id, `Marked order #${String(id).padStart(4,'0')} as arrived`);
  if (ord.customer_id) await bot.sendMessage(ord.customer_id, `Hi, here's the driver for order #${String(id).padStart(4,'0')}. Please collect your order.`); // eslint-disable-next-line no-unused-vars
  saveData();
});

bot.onText(/\/complete (\d+)/, async (msg, match) => {
  const id = Number(match[1]);
  const ord = orders.find(o => o.order_id === id);
  if (!ord) return bot.sendMessage(msg.chat.id, 'Order not found');
  ord.order_status = 'completed'; ord.order_status_emoji = '✅'; ord.driver_status = 'online';
  await bot.sendMessage(msg.chat.id, `Completed order #${String(id).padStart(4,'0')}`);
  if (ord.customer_id) { // eslint-disable-next-line no-unused-vars
  await bot.sendMessage(ord.customer_id, `Thank you for ordering! Please rate your delivery experience.`, K.inline.feedbackKeyboard(id));
  }
  saveData();
});

// Start polling only when run directly (require() from tests or serverless webhook handler should not start the bot)
if (require.main === module) {
  // detect environment
  const VERCEL_ENV = process.env.VERCEL_ENV || process.env.NODE_ENV || 'local';
  console.log('[ENV]', { VERCEL_ENV, NODE_ENV: process.env.NODE_ENV, VERCEL: process.env.VERCEL });

  // Only start polling when running locally or under `vercel dev` (development). On Vercel/production the bot should run as webhook.
  const shouldStartPolling = !process.env.VERCEL_ENV || process.env.VERCEL_ENV === 'development' || VERCEL_ENV === 'local';

  // Short runtime mode log for quick diagnostics
  console.log('[BOT MODE]', shouldStartPolling ? 'polling' : 'webhook');

  if (shouldStartPolling) {
    // Delete any webhook that may be set (prevents 409 when switching from webhook to polling)
    bot.deleteWebHook().then(() => {
      console.log('Webhook cleared (if any). Starting long polling...');
      try { bot.startPolling(); console.log(`Bot started. Waiting for updates... instance=${INSTANCE_ID}`); } catch (e) { console.error('Failed to start polling', e && e.message); }
    }).catch(err => {
      console.error('Failed to delete webhook (continuing):', err && err.message);
      try { bot.startPolling(); console.log(`Bot started. Waiting for updates... instance=${INSTANCE_ID}`); } catch (e) { console.error('Failed to start polling', e && e.message); }
    });
  } else {
    console.log(`[BOT] not starting polling because VERCEL_ENV=${VERCEL_ENV}; assume webhook mode (api/webhook.js will call bot.processUpdate)`);
  }

  // Diagnostic: print current webhook info for the bot (helps debug 409 errors)
  setTimeout(async () => {
    try {
      const info = await bot.getWebHookInfo ? bot.getWebHookInfo() : null;
      if (info && typeof info.then === 'function') {
        info.then(i => console.log('getWebHookInfo:', JSON.stringify(i, null, 2))).catch(e => console.error('getWebHookInfo failed', e && e.message));
      } else {
        console.log('getWebHookInfo: not available');
      }
    } catch (e) {
      console.error('getWebHookInfo error', e && e.message);
    }
    // attempt to fetch bot username for helpful /start links
    try {
      const me = await bot.getMe();
      if (me && me.username) {
        global.BOT_USERNAME = me.username;
        console.log('Bot username:', BOT_USERNAME);
      }
    } catch (e) {
      console.error('Failed to get bot username', e && e.message);
    }
  }, 500);
}

// Export helpers for tests (do not start the bot when required)
module.exports = {
  saveData,
  createOrder,
  DATA_FILE,
  // expose a waiter for pending saves (for test scripts)
  __waitForSaves: () => _savePromise,
  // testing helpers
  loadData,
  orders,
  drivers,
  customers,
  qrCodes
  , bot
}


// Lightweight cross-process lock using mkdir (atomic) to prevent races across multiple bot instances.
function acquireAssignLock(orderId) {
  try {
    const lockDir = path.join(__dirname, 'locks');
    if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir);
    const myLock = path.join(lockDir, `assign-${orderId}`);
    fs.mkdirSync(myLock);
    return myLock;
  } catch (e) {
    // failed to acquire lock (already exists)
    return null;
  }
}

function releaseAssignLock(lockPath) {
  try {
    if (lockPath && fs.existsSync(lockPath)) fs.rmdirSync(lockPath);
  } catch (e) { /* ignore */ }
}
