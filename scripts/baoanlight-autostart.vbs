' Starts the robot and every file-based watcher with no console window.
' Put a shortcut to this file in shell:startup to run it at login.
'
' The robot covers Claude Code (its own hooks) — the three agents with no hook
' of their own are Codex, DeepSeek Harness and WorkBuddy, watched by `watch all`.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh = CreateObject("WScript.Shell")

' Robot + state server. A no-op if it is already running.
sh.Run "node """ & root & "\src\cli.js"" start", 0, False
' Codex / DeepSeek Harness / WorkBuddy — one process each, all reporting in.
sh.Run "node """ & root & "\src\cli.js"" watch all", 0, False
