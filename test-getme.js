require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('NO TOKEN'); process.exit(1); }
const bot = new TelegramBot(token, { polling: false });
bot.getMe().then(u => {
  console.log('OK bot:', u.username, 'id:', u.id);
  process.exit(0);
}).catch(e => {
  console.error('ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
