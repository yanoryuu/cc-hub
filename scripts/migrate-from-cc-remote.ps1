# CC Remote -> CC Hub 移行 (design §14)
#   .\migrate-from-cc-remote.ps1            移行
#   .\migrate-from-cc-remote.ps1 -Rollback  切り戻し
#   -WhatIf で実行内容の表示のみ。旧 cc-remote フォルダは削除しない。
param(
    [switch]$WhatIf,
    [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$oldVbs = Join-Path $startup 'cc-remote.vbs'
$oldTask = 'CC Remote Watchdog'
$oldDir = 'C:\Users\yanor\cc-remote'
$dataDir = if ($env:CC_HUB_DATA_DIR) { $env:CC_HUB_DATA_DIR } else { Join-Path $env:APPDATA 'cc-hub' }
$cfgPath = Join-Path $dataDir 'config.json'

function Say($m) { if ($WhatIf) { Write-Host "[WhatIf] $m" } else { Write-Host $m } }

function Stop-Port($p) {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
        # 無関係なプロセスを止めないよう、cc-remote / cc-hub の node だけを対象にする
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)" -ErrorAction SilentlyContinue
        $cmd = if ($proc) { [string]$proc.CommandLine } else { '' }
        $isOurs = ($proc -and $proc.Name -eq 'node.exe' -and ($cmd -match 'server\.js' -or $cmd -match 'daemon[\\/]dist[\\/]main\.js'))
        if (-not $isOurs) {
            Write-Host "ポート $p は別のプログラム (PID $($c.OwningProcess): $($proc.Name)) が使っているため停止しません。中断します。"
            exit 1
        }
        Say "ポート $p を使うプロセス (PID $($c.OwningProcess): $cmd) を停止"
        if (-not $WhatIf) { Stop-Process -Id $c.OwningProcess -Force }
    } else { Say "ポート $p は未使用" }
}

function Set-HubPort($p) {
    Say "cc-hub の config.json の port を $p に設定: $cfgPath"
    if ($WhatIf) { return }
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
    $cfg = $null
    if (Test-Path $cfgPath) { $cfg = Get-Content -Raw $cfgPath | ConvertFrom-Json }
    if (-not $cfg) { $cfg = New-Object psobject }
    if ($cfg.PSObject.Properties['port']) { $cfg.port = $p } else { $cfg | Add-Member -NotePropertyName port -NotePropertyValue $p }
    [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
}

function Start-Hub {
    Say "cc-hub デーモンを起動 (scripts\cc-hub.vbs)"
    if (-not $WhatIf) { Start-Process wscript -ArgumentList (Join-Path $PSScriptRoot 'cc-hub.vbs') }
}

if (-not $Rollback) {
    $daemonJs = Join-Path $repo 'packages\daemon\dist\main.js'
    if (-not (Test-Path $daemonJs)) {
        Write-Warning "デーモンが未ビルドです: $daemonJs"
        if (-not $WhatIf) { throw 'build required' }
    }
    # 1. 旧サーバー停止 (7860)
    Stop-Port 7860
    # 2. 旧スタートアップ無効化
    Say "リネーム: $oldVbs -> cc-remote.vbs.disabled"
    if (-not $WhatIf -and (Test-Path $oldVbs)) { Rename-Item $oldVbs 'cc-remote.vbs.disabled' -Force }
    # 3. 旧 Watchdog タスク無効化
    Say "タスク無効化: $oldTask"
    if (-not $WhatIf) { schtasks /Change /TN $oldTask /DISABLE | Out-Null }
    # 4. cc-hub を 7860 に
    Stop-Port 7861
    Set-HubPort 7860
    Start-Hub
    Write-Host ''
    Write-Host '確認: ' -NoNewline; Write-Host 'Get-NetTCPConnection -LocalPort 7860 -State Listen ; スマホから tailscale 経由で接続 ; scripts\install.ps1 で cc-hub 側の自動起動を登録'
    Write-Host "切り戻し: .\migrate-from-cc-remote.ps1 -Rollback (旧フォルダ $oldDir は保持)"
} else {
    Stop-Port 7860
    $dis = "$oldVbs.disabled"
    Say "リネーム: $dis -> cc-remote.vbs"
    if (-not $WhatIf -and (Test-Path $dis)) { Rename-Item $dis 'cc-remote.vbs' -Force }
    Say "タスク有効化: $oldTask"
    if (-not $WhatIf) { schtasks /Change /TN $oldTask /ENABLE | Out-Null }
    Set-HubPort 7861
    Say "旧 cc-remote サーバーを起動: $oldDir (node server.js)"
    if (-not $WhatIf) { Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory $oldDir -WindowStyle Hidden }
    Say "必要なら cc-hub デーモンを 7861 で再起動してください"
}
