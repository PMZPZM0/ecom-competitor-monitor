$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ApiUrl = "http://localhost:4317/api/health"
$AppUrl = "http://localhost:5173"

if (-not (Test-Path (Join-Path $ProjectRoot "node_modules\.bin\lark-cli.cmd"))) {
  Start-Process -FilePath "npm.cmd" -WorkingDirectory $ProjectRoot -ArgumentList "install" -Wait -NoNewWindow
}

function Test-AppRunning {
  try {
    Invoke-RestMethod -Uri $ApiUrl -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

if (-not (Test-AppRunning)) {
  Start-Process `
    -FilePath "powershell.exe" `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Minimized `
    -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "npm run dev"

  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    if (Test-AppRunning) { break }
  }
}

Start-Process $AppUrl
