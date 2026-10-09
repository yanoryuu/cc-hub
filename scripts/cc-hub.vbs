' CC Hub デーモンをログイン時にバックグラウンド起動する(ウィンドウなし)
' 解除するにはスタートアップフォルダからこのファイルを削除
Set ws = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repo = "C:\Users\yanor\cc-hub"
dataDir = ws.ExpandEnvironmentStrings("%APPDATA%") & "\cc-hub"
If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir
ws.CurrentDirectory = repo
ws.Run "cmd /c node " & repo & "\packages\daemon\dist\main.js >> " & dataDir & "\daemon.log 2>&1", 0
