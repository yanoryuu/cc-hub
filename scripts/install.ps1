# CC Hub インストール: スタートアップ登録 + 死活監視タスク登録
#   .\install.ps1            インストール
#   .\install.ps1 -WhatIf    実行内容を表示するだけ
#   .\install.ps1 -Uninstall 登録解除
param(
    [switch]$WhatIf,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$scripts = Join-Path $repo 'scripts'
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$startupVbs = Join-Path $startup 'cc-hub.vbs'
$taskName = 'CC Hub Watchdog'
# schtasks /TR はクォートが壊れやすいのでスペースを含まないパスを使う
$taskCmd = "wscript $scripts\watchdog.vbs"

function Say($m) { if ($WhatIf) { Write-Host "[WhatIf] $m" } else { Write-Host $m } }

if ($Uninstall) {
    Say "スタートアップから削除: $startupVbs"
    if (-not $WhatIf -and (Test-Path $startupVbs)) { Remove-Item $startupVbs -Force }
    Say "タスク削除: $taskName"
    if (-not $WhatIf) { schtasks /Delete /TN $taskName /F | Out-Null }
    return
}

# ビルド確認
$daemonJs = Join-Path $repo 'packages\daemon\dist\main.js'
if (-not (Test-Path $daemonJs)) {
    Write-Warning "デーモンが未ビルドです: $daemonJs (npm run build を実行してください)"
    if (-not $WhatIf) { throw 'build required' }
}
if ($scripts -match '\s') { throw "スペースを含むパスは未対応です: $scripts" }

Say "コピー: $scripts\cc-hub.vbs -> $startupVbs"
if (-not $WhatIf) { Copy-Item (Join-Path $scripts 'cc-hub.vbs') $startupVbs -Force }

Say "タスク登録: $taskName (5分ごと) /TR $taskCmd"
if (-not $WhatIf) {
    schtasks /Create /TN $taskName /SC MINUTE /MO 5 /TR $taskCmd /F
    if ($LASTEXITCODE -ne 0) { throw 'schtasks 登録に失敗しました' }
}
Write-Host '完了'
