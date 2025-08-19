pwsh-commands:

restart env.:
```
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -s 1; node index.js
````

check syntax errors:
```
node -e "require('./index.js')"
```