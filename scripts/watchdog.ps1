# CC Hub 死活監視: 設定のポートで誰も Listen していなければデーモンを再起動する
$dataDir = if ($env:CC_HUB_DATA_DIR) { $env:CC_HUB_DATA_DIR } else { Join-Path $env:APPDATA 'cc-hub' }
$port = 7861
try {
    $cfg = Get-Content -Raw -Path (Join-Path $dataDir 'config.json') | ConvertFrom-Json
    if ($cfg.port) { $port = [int]$cfg.port }
} catch { }

$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conn) {
    $repo = Split-Path -Parent $PSScriptRoot
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
    $log = Join-Path $dataDir 'daemon.log'
    Start-Process -FilePath 'node' -ArgumentList (Join-Path $repo 'packages\daemon\dist\main.js') `
        -WorkingDirectory $repo -WindowStyle Hidden `
        -RedirectStandardOutput $log -RedirectStandardError (Join-Path $dataDir 'daemon.err.log')
}
