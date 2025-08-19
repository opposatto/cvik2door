// Vercel serverless webhook receiver for Telegram
const { bot } = require('../index.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('OK');
  try {
    // Telegram sends JSON body as update
    await bot.processUpdate(req.body);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook processing failed', err && err.message);
    return res.status(500).send('error');
  }
};
