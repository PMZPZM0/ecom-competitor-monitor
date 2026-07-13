$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ApiUrl = "http://127.0.0.1:4317/api/health"
$AppUrl = "http://127.0.0.1:5173"

if (-not (Test-Path (Join-Path $ProjectRoot "node_modules\.bin\lark-cli.cmd"))) {
  Start-Process -FilePath "npm.cmd" -WorkingDirectory $ProjectRoot -ArgumentList "install" -Wait -NoNewWindow
}

function Test-Url([string]$Url) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Start-AppService([string]$ScriptName) {
  Start-Process `
    -FilePath "powershell.exe" `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "npm run $ScriptName"
}

if (-not (Test-Url $ApiUrl)) {
  Start-AppService "dev:server"
}
if (-not (Test-Url $AppUrl)) {
  Start-AppService "dev:web"
}

for ($i = 0; $i -lt 30; $i++) {
  if ((Test-Url $ApiUrl) -and (Test-Url $AppUrl)) { break }
  Start-Sleep -Seconds 1
}

if (-not ((Test-Url $ApiUrl) -and (Test-Url $AppUrl))) {
  throw "Ecom Monitor startup failed: local frontend or backend was not ready within 30 seconds."
}

Start-Process $AppUrl
