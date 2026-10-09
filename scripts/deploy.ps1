<#
.SYNOPSIS
  CC Hub を最新のコードで本番(ポート 7860)に反映する。

.DESCRIPTION
  1. 全パッケージをビルドする(web / daemon / desktop の dist を作り直す)
  2. 7860 で動いている CC Hub デーモン(node ...daemon\dist\main.js)だけを止める
  3. scripts\cc-hub.vbs でデーモンを起動し、応答するまで待つ

  CC Hub から起動したセッションは、デーモン再起動後に --resume で自動再開される。
  VS Code やターミナルで起動したセッション(外部セッション)には影響しない。

.PARAMETER WhatIf
  何もせず、実行する内容だけを表示する。

.PARAMETER SkipBuild
  ビルドを省略して再起動だけ行う。
#>
param(
    [switch]$WhatIf,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 7860
$cfgPath = Join-Path $env:APPDATA 'cc-hub\config.json'
if (Test-Path $cfgPath) {
    try { $port = [int](Get-Content $cfgPath -Raw | ConvertFrom-Json).port } catch {}
}

function Say($m) { if ($WhatIf) { Write-Host "[WhatIf] $m" } else { Write-Host $m } }

# 1. ビルド
if (-not $SkipBuild) {
    Say "ビルド: npm run build ($root)"
    if (-not $WhatIf) {
        Push-Location $root
        try {
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "ビルドに失敗しました (exit $LASTEXITCODE)" }
        } finally { Pop-Location }
    }
}

# 2. 停止(CC Hub のデーモンだけ)
$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)"
    $cmd = [string]$proc.CommandLine
    if ($proc.Name -ne 'node.exe' -or $cmd -notmatch 'daemon[\\/]dist[\\/]main\.js') {
        Write-Host "ポート $port は CC Hub 以外 (PID $($c.OwningProcess): $cmd) が使っているため中断します。"
        exit 1
    }
    Say "デーモンを停止: PID $($c.OwningProcess)"
    if (-not $WhatIf) { Stop-Process -Id $c.OwningProcess -Force; Start-Sleep -Seconds 1 }
} else {
    Say "ポート $port で動いているデーモンはありません"
}

# 3. 起動して応答を待つ
$vbs = Join-Path $root 'scripts\cc-hub.vbs'
Say "デーモンを起動: wscript //B $vbs"
if (-not $WhatIf) {
    Start-Process wscript.exe -ArgumentList "//B `"$vbs`""
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 2
            if ($r.StatusCode -eq 200) { $ok = $true; break }
        } catch {}
    }
    if ($ok) {
        Write-Host "起動しました: http://127.0.0.1:$port/ (デスクトップアプリはトレイの「再読み込み」で新しい画面になります)"
    } else {
        Write-Host "起動を確認できませんでした。$env:APPDATA\cc-hub\daemon.err.log を確認してください。"
        exit 1
    }
}
