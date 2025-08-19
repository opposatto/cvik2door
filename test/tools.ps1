# Test tools menu for unlimited-bot
# Usage: Open PowerShell, cd to the repo root and run: .\test\tools.ps1

function Show-Menu {
    Clear-Host
    Write-Host "Unlimited-bot Test & Debug Menu" -ForegroundColor Cyan
    Write-Host "1) Start bot (node index.js)"
    Write-Host "2) Run save atomic test (node .\test\test-save-atomic.js)"
    Write-Host "3) Run order persistence test (node .\test\test-order-persistence.js)"
    Write-Host "4) Run full test suite (node .\test\test-suite.js)"
    Write-Host "5) Run bracket scanner (node ./tools/bracket_scan.js)"
    Write-Host "6) Show recent data.json (type data.json)"
    Write-Host "0) Exit"
}

while ($true) {
    Show-Menu
    $choice = Read-Host "Select an option"
    switch ($choice) {
        '1' { Write-Host "Starting bot... (CTRL+C to stop)"; node .\index.js }
    '2' { Write-Host "Running save atomic test"; node .\test\test-save-atomic.js; Read-Host 'Press Enter to continue' }
    '3' { Write-Host "Running order persistence test"; node .\test\test-order-persistence.js; Read-Host 'Press Enter to continue' }
    '4' { Write-Host "Running full test-suite"; node .\test\test-suite.js; Read-Host 'Press Enter to continue' }
        '5' { Write-Host "Running bracket scanner"; node .\tools\bracket_scan.js; Read-Host 'Press Enter to continue' }
        '6' { if (Test-Path .\data.json) { Get-Content .\data.json -TotalCount 200 } else { Write-Host 'data.json not found' } ; Read-Host 'Press Enter to continue' }
        '0' { break }
        default { Write-Host "Unknown option: $choice" -ForegroundColor Yellow; Start-Sleep -Seconds 1 }
    }
}

Write-Host "Exiting test tools." -ForegroundColor Green
