' watchdog.ps1 をウィンドウを出さずに実行するラッパー(タスクスケジューラ用)
Set ws = CreateObject("Wscript.Shell")
ws.Run "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\yanor\cc-hub\scripts\watchdog.ps1", 0
