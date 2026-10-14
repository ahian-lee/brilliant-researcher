param([int]$Target, [string]$State)
$ErrorActionPreference='Stop'
$owned=Get-Content $State -Raw|ConvertFrom-Json
if($owned.pid -ne $Target){throw 'Probe ownership mismatch'}
$p=Get-CimInstance Win32_Process -Filter "ProcessId=$Target"
if(!$p -or $p.CommandLine -notlike '*tests\dashboardConsoleProbe.mjs*' -or !$p.CommandLine.Contains($State)){throw 'Not the owned console probe'}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BRIConsoleDiagnostic {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint id);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList(uint[] ids,uint count);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint evt,uint group);
 public delegate bool Handler(uint evt);
 public static Handler Ignore = delegate(uint evt) { return true; };
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(Handler fn,bool add);
}
'@
[BRIConsoleDiagnostic]::FreeConsole()|Out-Null
$attached=[BRIConsoleDiagnostic]::AttachConsole([uint32]$Target)
$errorCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
$ids=New-Object uint32[] 16
$sent=$false
$members=@()
if($attached){
 [BRIConsoleDiagnostic]::SetConsoleCtrlHandler([BRIConsoleDiagnostic]::Ignore,$true)|Out-Null
 $count=[BRIConsoleDiagnostic]::GetConsoleProcessList($ids,16)
 if($count -gt 16){throw 'Too many console members; will not signal'}
 $members=@($ids[0..($count-1)])
 $allowed=@($Target,$PID)
 if(Test-Path "$State.parent"){$allowed+= [int](Get-Content "$State.parent" -Raw|ConvertFrom-Json).pid}
 if(@($members|Where-Object {$_ -notin $allowed}).Count){throw 'Console contains unrelated processes; will not signal'}
 $sent=[BRIConsoleDiagnostic]::GenerateConsoleCtrlEvent(0,0)
 Start-Sleep -Milliseconds 800
 [BRIConsoleDiagnostic]::FreeConsole()|Out-Null
}
@{target=$Target;targetSession=$p.SessionId;callerSession=(Get-Process -Id $PID).SessionId;attached=$attached;attachError=$errorCode;members=$members;sent=$sent}|ConvertTo-Json -Compress|Set-Content "$State.signal"
