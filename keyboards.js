// Centralized reply keyboard references extracted from index.js
// Grouped by role: admin, driver, customer
// These are copies of the reply_markup objects used in index.js and
// intended as a single place to reference reply keyboards in other modules.

/*
  Notes about usages (from index.js):
  - adminMainKeyboard: shown to ADMIN in /start, /clear_admin_ui and used to present the admin menu
  - driverOfflineKeyboard: shown to drivers when they are offline (after approval or on /disconnect)
  - driverOnlineKeyboard: shown when drivers CONNECT or /connect
  - No persistent customer-level reply keyboard was defined in index.js (customers use inline keyboards and remove_keyboard calls)
*/

const adminMainKeyboard = {
  reply_markup: {
    keyboard: [
      [
        { text: '📥ORDERS' },
        { text: '⚡ACTIVE' },
        { text: '✅COMPLETED' }
      ],
      [
        { text: '➕NEW' },
        { text: '📊STATS' },
        { text: '⚙️SETTINGS' }
      ]
    ],
    resize_keyboard: true
  }
};

function adminMainKeyboardFactory(emojisMode = false) {
  if (emojisMode) {
    return {
      reply_markup: {
        keyboard: [
          [ { text: '📥' }, { text: '⚡' }, { text: '✅' } ],
          [ { text: '➕' }, { text: '📊' }, { text: '⚙️' } ]
        ],
        resize_keyboard: true
      }
    };
  }
  return adminMainKeyboard;
}

// Driver keyboards (reply keyboards shown in private chat)
const driverOfflineKeyboard = {
  reply_markup: {
    keyboard: [
      [ { text: '🚀CONNECT' } ],
      [ { text: '📊STATS' }, { text: '⚙️SETTINGS' } ]
    ],
    resize_keyboard: true
  }
};

const driverOnlineKeyboard = {
  reply_markup: {
    keyboard: [
      [ { text: '✖️LOGOUT' }, { text: '📥MY ORDERS' } ],
      [ { text: '📊STATS' }, { text: '⚙️SETTINGS' } ]
    ],
    resize_keyboard: true
  }
};

// Customers: index.js does not define a persistent reply keyboard for customers.
// Customers mainly receive inline keyboards or the bot removes any keyboard via remove_keyboard.
const customerMainKeyboard = null;

// Inline keyboards (factories and common static ones)
// These mirror inline keyboards found in index.js and provide small helper factories
// so other modules can build the same inline UIs.

function driverReadyKeyboard(orderId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🛍️ PICKUP', callback_data: `driver_pickup:${orderId}` },
          { text: '🗺️ MAP', callback_data: `driver_route:${orderId}` }
        ]
      ]
    }
  };
}

function adminOrderQuickActions(orderId) {
  return { reply_markup: { inline_keyboard: [[{ text: '⚡ GO', callback_data: `go:${orderId}` }, { text: '❌ Cancel', callback_data: `cancel:${orderId}` }]] } };
}

function driverApprovalKeyboard(driverId) {
  return { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `drv_approve:${driverId}` }, { text: '❌ Reject', callback_data: `drv_reject:${driverId}` }]] } };
}

function adminSettingsKeyboard(archiveDays, emojisMode = false) {
  // emojisMode: when true, show only emoji labels for admin UI buttons (except amounts/lists)
  if (emojisMode) {
    return { reply_markup: { inline_keyboard: [[{ text: '🔲', callback_data: 'settings:qr' }, { text: '👥', callback_data: 'settings:admins' }, { text: '🚗', callback_data: 'settings:drivers' }], [{ text: '🎭', callback_data: 'settings:emojis' }, { text: `🔁 ${archiveDays}d`, callback_data: 'settings:archive' }], [{ text: '⬅️', callback_data: 'back:menu' }]] } };
  }
  return { reply_markup: { inline_keyboard: [[{ text: 'Manage QR', callback_data: 'settings:qr' }, { text: 'Manage Admins', callback_data: 'settings:admins' }, { text: 'Manage Drivers', callback_data: 'settings:drivers' }], [{ text: 'Emojis mode', callback_data: 'settings:emojis' }, { text: `Archive ${archiveDays}d`, callback_data: 'settings:archive' }], [{ text: '⬅️ Go back', callback_data: 'back:menu' }]] } };
}

function archiveDaysKeyboard(currentDays) {
  const rows = [
    [{ text: '7d', callback_data: 'settings:set:archiveDays:7' }, { text: '14d', callback_data: 'settings:set:archiveDays:14' }],
    [{ text: '30d', callback_data: 'settings:set:archiveDays:30' }, { text: '⬅️ Go back', callback_data: 'back:menu' }]
  ];
  return { reply_markup: { inline_keyboard: rows } };
}

function qrCodesListKeyboard(qrCodes) {
  // qrCodes: array of { id, code, enabled }
  const rows = (Array.isArray(qrCodes) ? qrCodes : []).map(q => [{ text: `${q.enabled ? '✅' : '⬜'} ${q.code}`, callback_data: `qr:toggle:${q.id}` }, { text: '⚙️', callback_data: `qr:opts:${q.id}` }]);
  rows.push([{ text: '➕ Add QR', callback_data: 'qr:add' }, { text: '⬅️ Back', callback_data: 'back:menu' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function qrOptionsKeyboard(q) {
  // q: { id }
  return { reply_markup: { inline_keyboard: [[{ text: '🔍 Preview', callback_data: `qr:preview:${q.id}` }, { text: '🗑️ Delete', callback_data: `qr:del:${q.id}` }], [{ text: '⬅️ Back', callback_data: 'settings:qr' }]] } };
}

function sendQrToOrderKeyboard(orderId, qrCodes) {
  // build rows: each qr -> callback qr:send:<qid>:<orderId>
  const rows = (Array.isArray(qrCodes) ? qrCodes : []).map(q => [{ text: `${q.enabled ? '✅' : '⬜'} ${q.code}`, callback_data: `qr:send:${q.id}:${orderId}` }]);
  rows.push([{ text: 'Cancel', callback_data: 'back:menu' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function driverActiveOrderKeyboard(orderId) {
  // LOCATION -> START LIVE; driver presses ARRIVED to stop live automatically
  return { reply_markup: { inline_keyboard: [[{ text: '🏁 ARRIVED', callback_data: `driver_arrived:${orderId}` }, { text: '🗺️ START LIVE', callback_data: `driver_start_live:${orderId}` }, { text: '⏰ DELAY', callback_data: `driver_delay:${orderId}` }]] } };
}

function etaKeyboard(orderId) {
  return { reply_markup: { inline_keyboard: [[{ text: '❔ETA', callback_data: `eta:${orderId}` }]] } };
}

function openInMapsKeyboard(gLink) {
  return { reply_markup: { inline_keyboard: [[{ text: 'Open in Maps', url: gLink }]] } };
}

function customerOkKeyboard(orderId) {
  return { reply_markup: { inline_keyboard: [[{ text: 'OK', callback_data: `cust_ok:${orderId}` }]] } };
}

function buildAdminOrderKeyboard(ord, editMode = true, backTarget = null) {
  const inline = [];
  if (editMode) {
    inline.push([
      { text: 'CASH', callback_data: `setpay:CASH:${ord.order_id}` },
      { text: 'QR', callback_data: `setpay:QR:${ord.order_id}` },
      { text: 'PAID', callback_data: `setpaid:${ord.order_id}` },
      { text: `💲 ${ord.total_amount || 0}`, callback_data: `settotal:${ord.order_id}` }
    ]);
    // removed Send QR button as in original
    inline.push([{ text: '📌 Set location', callback_data: `setloc:${ord.order_id}` }, { text: '➕ Attach media', callback_data: `attach:${ord.order_id}` }]);
    inline.push([{ text: '✏️ Edit customer', callback_data: `editcust:${ord.order_id}` }, { text: '📝 Edit items', callback_data: `edititems:${ord.order_id}` }]);
    const backCb = backTarget ? `back:${backTarget}` : 'back:menu';
    inline.push([{ text: '⚡Go', callback_data: `go:${ord.order_id}` }, { text: '❌ Cancel', callback_data: `cancel:${ord.order_id}` }, { text: '⬅️ Go back', callback_data: backCb }]);
  } else {
    inline.push([{ text: '🗑️ Delete', callback_data: `delete:${ord.order_id}` }, { text: '↩️ Go back', callback_data: 'back:menu' }]);
  }
  return { reply_markup: { inline_keyboard: inline } };
}

function driverSettingsKeyboard(lang = 'EN') {
  // lang: 'EN' or 'KH' (Khmer). Show the toggle label as a flag/text.
  const isKh = String(lang).toUpperCase() === 'KH';
  const toggleLabel = isKh ? 'EN' : '🇰🇭';
  return {
    reply_markup: {
      keyboard: [
        [ { text: toggleLabel } ],
        [ { text: '📊STATS' }, { text: '⚙️SETTINGS' } ]
      ],
      resize_keyboard: true
    }
  };
}

function delayOptionsKeyboard(orderId) {
  return { reply_markup: { inline_keyboard: [[{ text: '❕2mn', callback_data: `delay:2:${orderId}` }, { text: '❗5mn', callback_data: `delay:5:${orderId}` }, { text: '‼️+10mn', callback_data: `delay:10:${orderId}` }]] } };
}

function archiveApproveKeyboard(id) {
  return { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `archive_approve:${id||0}` }, { text: '❌ Reject', callback_data: `archive_reject:${id||0}` }]] } };
}

function feedbackKeyboard(orderId) {
  return { reply_markup: { inline_keyboard: [[
    { text: '1', callback_data: `fb:1:${orderId}` },
    { text: '2', callback_data: `fb:2:${orderId}` },
    { text: '3', callback_data: `fb:3:${orderId}` },
    { text: '4', callback_data: `fb:4:${orderId}` },
    { text: '5', callback_data: `fb:5:${orderId}` }
  ]] } };
}

// Export all keyboards
module.exports = {
  admin: {
  adminMainKeyboard,
  adminMainKeyboardFactory
  },
  driver: {
  driverOfflineKeyboard,
  driverOnlineKeyboard,
  driverSettingsKeyboard
  },
  customer: {
    customerMainKeyboard
  },
  inline: {
    driverReadyKeyboard,
    adminOrderQuickActions,
    driverApprovalKeyboard,
    adminSettingsKeyboard,
    archiveDaysKeyboard,
    qrCodesListKeyboard,
    qrOptionsKeyboard,
    sendQrToOrderKeyboard,
    driverActiveOrderKeyboard,
    etaKeyboard,
    openInMapsKeyboard,
    customerOkKeyboard,
    delayOptionsKeyboard,
    archiveApproveKeyboard,
    feedbackKeyboard
  }
};

// End of file
