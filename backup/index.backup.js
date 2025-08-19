// Full snapshot of index.js (copied for offline editing / testing)
// NOTE: this file is a static backup to edit during tests. Changes here won't affect the live bot.
// The real index.js remains in the project root.

const TelegramBot = require('node-telegram-bot-api');
const dotenv = require('dotenv');
dotenv.config();
const fs = require('fs');
const path = require('path');

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

// ... (rest of index.js omitted for brevity in backup – the live file remains authoritative)


