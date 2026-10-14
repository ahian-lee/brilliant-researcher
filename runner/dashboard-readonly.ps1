param(
  [string]$Projects,
  [ValidateRange(1,65535)][int]$Port = 8791,
  [switch]$Background,
  [ValidateSet('run','start','status','stop','uninstall')][string]$Action = 'run'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$Root = Split-Path $PSScriptRoot -Parent
$TaskName = "BRI-Researcher-Dashboard-$Port"
$LogDir = Join-Path $Root 'var'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$State = Join-Path $LogDir "dashboard-$Port-child.json"
$Log = Join-Path $LogDir "dashboard-$Port-service.log"
$NativeHost = Join-Path $LogDir 'dashboard-windows-host.exe'
function Get-OwnedDashboard {
  try {
    $owned = Get-Content $State -Raw | ConvertFrom-Json
    $child = Get-Process -Id $owned.pid -ErrorAction Stop
    $hostProcess = Get-Process -Id $owned.hostPid -ErrorAction Stop
    $childInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($owned.pid)"
    $hostInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($owned.hostPid)"
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ([string]$child.StartTime.ToUniversalTime().Ticks -ne [string]$owned.startTicks -or [string]$hostProcess.StartTime.ToUniversalTime().Ticks -ne [string]$owned.hostStartTicks) { return $null }
    if (!$childInfo.CommandLine.Contains((Join-Path $PSScriptRoot 'dashboard-host.mjs')) -or !$hostInfo.CommandLine.Contains($NativeHost) -or $listener.OwningProcess -ne $owned.pid) { return $null }
    return $owned
  } catch { return $null }
}
function Write-ServiceLog([string]$Message) { Add-Content -Path $Log -Value "$(Get-Date -Format o) $Message" }
if ($Background) { $Action = 'start' }
if ($Action -eq 'status') {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    $reachable = $false
    $owned = Get-OwnedDashboard
    if ($owned) { try { $null = Invoke-RestMethod "http://127.0.0.1:$Port/api/projects" -TimeoutSec 2; $reachable = $true } catch {} }
    [pscustomobject]@{TaskName=$TaskName;State=[string]$task.State;OwnerVerified=($null -ne $owned);DataAvailable=$reachable;LastResult=$info.LastTaskResult;LastRun=$info.LastRunTime} | ConvertTo-Json -Compress
  } else { Write-Output 'Dashboard background task is not registered' }
  exit 0
}
if ($Action -eq 'stop' -or $Action -eq 'uninstall') {
  # An intentional stop also disables recovery; only a new start re-enables it.
  Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (Test-Path $State) {
    $owned = Get-Content $State -Raw | ConvertFrom-Json
    for ($attempt=0; $attempt -lt 20; $attempt++) {
      if (!(Get-Process -Id $owned.pid -ErrorAction SilentlyContinue) -and (!$owned.hostPid -or !(Get-Process -Id $owned.hostPid -ErrorAction SilentlyContinue))) { break }
      Start-Sleep -Milliseconds 250
    }
    $child = Get-Process -Id $owned.pid -ErrorAction SilentlyContinue
    if ($child) {
      $identity = Get-CimInstance Win32_Process -Filter "ProcessId = $($owned.pid)"
      if (!$owned.startTicks -or $child.ProcessName -ne 'node' -or [string]$child.StartTime.ToUniversalTime().Ticks -ne [string]$owned.startTicks -or $identity.CommandLine -notlike "*$(Join-Path $PSScriptRoot 'dashboard-host.mjs')*") { throw 'Dashboard child identity could not be verified; refusing to stop a process outside the scheduled task' }
      Stop-Process -Id $child.Id
      $child.WaitForExit()
    }
    if ($owned.hostPid) {
      $hostProcess = Get-Process -Id $owned.hostPid -ErrorAction SilentlyContinue
      if ($hostProcess) {
        $hostIdentity = Get-CimInstance Win32_Process -Filter "ProcessId = $($owned.hostPid)"
        if (!$owned.hostStartTicks -or [string]$hostProcess.StartTime.ToUniversalTime().Ticks -ne [string]$owned.hostStartTicks -or !$hostIdentity.CommandLine.Contains($NativeHost)) { throw 'Dashboard host identity could not be verified; refusing to stop another process' }
        Stop-Process -Id $hostProcess.Id
        $hostProcess.WaitForExit()
      }
    }
    Remove-Item $State -ErrorAction SilentlyContinue
  }
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw 'Dashboard task stopped, but this port is still occupied; inspect its owner' }
  if ($Action -eq 'uninstall') { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
  exit 0
}
if (!$Projects) { $Projects = Join-Path $Root 'var\aris-projects.local.json' }
$Projects = (Resolve-Path $Projects).Path
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Entry = Join-Path $Root 'apps\controller\src\server.ts'
if ($Action -eq 'start') {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq 'Running' -and $task.Actions[0].Execute -ne $NativeHost) { throw 'The background task is using the old console-based launcher; stop it before updating' }
  if (!$task -or $task.State -ne 'Running') {
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $hostEntry = Join-Path $PSScriptRoot 'dashboard-host.mjs'
    $nativeSource = Join-Path $PSScriptRoot 'DashboardWindowsHost.cs'
    $nativeHost = Join-Path $LogDir 'dashboard-windows-host.exe'
    if (!(Test-Path $nativeHost) -or (Get-Item $nativeSource).LastWriteTimeUtc -gt (Get-Item $nativeHost).LastWriteTimeUtc) {
      $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
      $build = Start-Process $compiler -ArgumentList @('/nologo','/target:winexe',('/out:"'+$nativeHost+'"'),('"'+$nativeSource+'"')) -RedirectStandardOutput (Join-Path $LogDir 'dashboard-host-build.out') -RedirectStandardError (Join-Path $LogDir 'dashboard-host-build.err') -PassThru
      $buildHandle=$build.Handle; $build.WaitForExit()
      if ($build.ExitCode -ne 0 -or !(Test-Path $nativeHost)) { throw 'Failed to build the console-free Windows Dashboard host; inspect dashboard-host-build.out / .err' }
    }
    $hostLog = Join-Path $LogDir "dashboard-$Port-host.log"
    $hostOut = Join-Path $LogDir "dashboard-$Port-host.stdout.log"
    $hostErr = Join-Path $LogDir "dashboard-$Port-host.stderr.log"
    $hostArguments = (@($Node,$hostEntry,$Projects,"$Port",$State,$hostLog,$hostOut,$hostErr) | ForEach-Object {'"'+$_+'"'}) -join ' '
    $taskAction = New-ScheduledTaskAction -Execute $nativeHost -Argument $hostArguments -WorkingDirectory $Root
    $loginTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    # IgnoreNew skips this trigger while the host runs. It recovers a missing host
    # without polling the API, starting models, or creating another watcher task.
    $recoveryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(3) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger @($loginTrigger,$recoveryTrigger) -Principal $principal -Settings $settings -Description 'Read-only BRI/ARIS Dashboard; remote execution and research scheduling disabled' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
  }
  # Report availability only after the requested data endpoint actually responds.
  $ready = $false
  for ($attempt=0; $attempt -lt 15; $attempt++) {
    try {
      $null = Invoke-RestMethod "http://127.0.0.1:$Port/api/projects" -TimeoutSec 2
      $ready = $true; break
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (!$ready) { throw "Dashboard failed to become available; inspect $Log" }
  $owned = Get-OwnedDashboard
  if (!$owned) { throw "Port $Port ownership or the console-free host could not be verified" }
  # The Windows host owns this file, including both parent and child identities.
  Write-Output "Dashboard ready: http://127.0.0.1:$Port/ (Windows task $TaskName; project workbench; legacy API read only)"
  exit 0
}
$env:BRI_ARIS_PROJECTS = $Projects
$env:BRI_DISABLE_REMOTE = '1'
$env:BRI_PORT = "$Port"
Set-Location $Root
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is already in use; leave the existing service intact" }
Write-ServiceLog "starting read-only Dashboard parent=$PID port=$Port"
try {
  $child = Start-Process -FilePath $Node -ArgumentList @(('"' + $Entry + '"')) -WorkingDirectory $Root -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $LogDir 'dashboard.stdout.log') -RedirectStandardError (Join-Path $LogDir 'dashboard.stderr.log')
  $handle = $child.Handle
  @{pid=$child.Id;startTicks=[string]$child.StartTime.ToUniversalTime().Ticks} | ConvertTo-Json -Compress | Set-Content $State
  Write-ServiceLog "started child=$($child.Id)"
  $child.WaitForExit()
  $result = $child.ExitCode
  Write-ServiceLog "exited child=$($child.Id) exitCode=$result"
  exit $result
} catch {
  Write-ServiceLog "startup failed: $($_.Exception.Message)"
  throw
}
