# deploy_and_set_webhook.ps1
# Deploy the project to Vercel and register the Telegram webhook for the deployed URL.
# Usage: .\scripts\deploy_and_set_webhook.ps1 -Token '<your_bot_token>' [-ProjectPath '.']
param(
  [Parameter(Mandatory=$true)]
  [string]$Token,
  [string]$ProjectPath = '.',
  [ValidateSet('production','preview','development')]
  [string]$Env = 'production',
  [switch]$PullEnv
)

# Ensure vercel is available via npx
Write-Host "Deploying to Vercel from $ProjectPath..."
Push-Location $ProjectPath
try {
  # Optionally pull Vercel env vars before deploying
  if ($PullEnv) {
    Write-Host "Pulling Vercel envs for environment: $Env into .env.local..."
    try {
      npx vercel env pull .env.local --environment $Env 2>&1 | Write-Host
      Write-Host "Pulled envs to .env.local"
    } catch {
      Write-Warning "Failed to pull envs: $_"
    }
  }

  # Deploy non-interactively. Use --prod when environment is production, otherwise use --confirm to accept defaults.
  if ($Env -eq 'production') {
    $deployOut = npx vercel --confirm --prod 2>&1
  } else {
    # preview or development deploy (uses vercel default, non-prod)
    $deployOut = npx vercel --confirm 2>&1
  }
  Write-Host $deployOut
  # try to extract the deploy URL from the output (last line containing 'https://')
  $lines = $deployOut -split "\r?\n"
  $urlLine = $lines | Select-String -Pattern 'https?://\S+' | Select-Object -Last 1
  $match = $null
  if ($urlLine) { $match = $urlLine.Matches[0].Value }
  if (-not $match) {
    Write-Error "Couldn't detect deploy URL from vercel output. Inspect output above and set webhook manually."
    return
  }
  $deployUrl = $match.Trim()
  Write-Host "Detected deploy URL: $deployUrl"

  $webhook = "$($deployUrl.TrimEnd('/'))/api/webhook"
  Write-Host "Registering Telegram webhook: $webhook"
  $resp = Invoke-WebRequest -Uri "https://api.telegram.org/bot$Token/setWebhook?url=$webhook" -UseBasicParsing -Method Get -ErrorAction Stop
  $body = $resp.Content
  Write-Host "setWebhook response:`n$body"
} catch {
  Write-Error "Deploy or webhook registration failed: $_"
} finally {
  Pop-Location
}
