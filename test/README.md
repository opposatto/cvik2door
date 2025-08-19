# unlimited-bot — README & deployment tutorial

Summary
This repository contains a minimal Telegram delivery bot scaffold that supports two modes:
- Local polling (development) — run the bot directly with Node.js.
- Serverless webhook (production) — deploy to Vercel and register Telegram webhook to `/api/webhook`.

This README documents environment setup, local development, testing, deploy automation and recommended workflow.

Prerequisites
- Node.js 16+ and npm
- A Telegram bot token and your Admin chat id

Environment

Create a `.env` or set environment variables before running:

```properties
TELEGRAM_BOT_TOKEN=your_bot_token_here
ADMIN_ID=your_admin_chat_id
```

Local development (polling)

- Start the bot locally (long-polling):

```pwsh
node .\index.js
```

- The bot prints `[BOT MODE] polling` when polling is active. Stop any local instance before switching to webhook mode to avoid Telegram 409 conflicts.

Local serverless (Vercel dev)

- Run `npx vercel dev` to emulate Vercel serverless functions locally. `VERCEL_ENV` will be `development` and the bot will not auto-start polling; API endpoints will run via `api/` routes.

Testing

- Tests live in `test/` (unit and integration helpers). Run the suite:

```pwsh
node .\test\test-suite.js
```

Deployment (Vercel webhook)

1. Deploy to Vercel (production):

```pwsh
npx vercel --prod
```

2. Register the webhook (PowerShell example):

```pwsh
#$token = "<YOUR_TELEGRAM_BOT_TOKEN>"
#$deploy = "https://your-deploy-url.vercel.app"
#Invoke-WebRequest -Uri "https://api.telegram.org/bot$token/setWebhook?url=$deploy/api/webhook" -UseBasicParsing | Select-Object -Expand Content
```
The serverless handler that receives updates is `api/webhook.js`.

Automated deploy + webhook script

- A PowerShell helper is included at `scripts/deploy_and_set_webhook.ps1`. It supports:

	- `-Token <BOT_TOKEN>` (required)
	- `-Env <production|preview|development>` (default: production)
	- `-PullEnv` to run `npx vercel env pull .env.local --environment <env>` before deploying

Examples:

```pwsh
# deploy production (default)
.\scripts\deploy_and_set_webhook.ps1 -Token '<YOUR_TELEGRAM_BOT_TOKEN>'

# deploy preview
.\scripts\deploy_and_set_webhook.ps1 -Token '<YOUR_TELEGRAM_BOT_TOKEN>' -Env preview

# pull env vars then deploy
.\scripts\deploy_and_set_webhook.ps1 -Token '<YOUR_TELEGRAM_BOT_TOKEN>' -PullEnv -Env production
```

Recommendations & notes

- Only one consumer (polling or webhook) should be active for the same bot token. Stop local polling before setting webhook.
- Add `.env.local` to `.gitignore` if you use `-PullEnv` to avoid committing secrets.
- Vercel sets `VERCEL_ENV` in their runtime; `index.js` respects this and will not start polling in production.

Key files

- `index.js` — main bot logic and startup guard
- `api/webhook.js` — webhook entrypoint for serverless
- `data.json` — persisted state (orders, drivers, counters)
- `scripts/deploy_and_set_webhook.ps1` — deploy + webhook helper
- `test/` — test scripts


Troubleshooting

- If Telegram returns 409, stop other pollers or delete the webhook before starting polling.
- Use `INSTANCE_ID` in logs to identify which process handled an update.

Next steps before push


- Stop any local bot process, verify webhook status via Telegram `getWebhookInfo`, then confirm webhook works by pinging the bot (send `/start` from admin).

