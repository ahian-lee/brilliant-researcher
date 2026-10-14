param([ValidateSet('install','start','status','stop','run','uninstall')][string]$Action='status')
$ErrorActionPreference='Stop'
$Root=Split-Path $PSScriptRoot -Parent
$Node='C:\Program Files\nodejs\node.exe'
$TaskName='BRI-Researcher-Controller'
$Log=Join-Path $Root 'var\controller-service.log'
$ChildState=Join-Path $Root 'var\controller-service-child.json'
function Log([string]$Message) { Add-Content -Path $Log -Value "$(Get-Date -Format o) $Message" }
if ($Action -eq 'install') {
  $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $taskAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$PSCommandPath`" -Action run" -WorkingDirectory $Root
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'BRI Controller, user session, no model dispatch host enabled' -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
} elseif ($Action -eq 'start') {
  Start-ScheduledTask -TaskName $TaskName
} elseif ($Action -eq 'stop' -or $Action -eq 'uninstall') {
  $projects=(Invoke-RestMethod 'http://127.0.0.1:8791/api/projects' -TimeoutSec 5).projects
  if (@($projects | Where-Object {$_.active_count -gt 0 -or $_.active_workflow_count -gt 0}).Count) {throw 'Active research exists; pause and reconcile before stopping'}
  Stop-ScheduledTask -TaskName $TaskName
  if (Test-Path $ChildState) {
    $owned=Get-Content $ChildState -Raw | ConvertFrom-Json
    $process=Get-Process -Id $owned.pid -ErrorAction SilentlyContinue
    if ($process) {
      if ($process.ProcessName -ne 'node' -or [string]$process.StartTime.ToUniversalTime().Ticks -ne [string]$owned.startTicks) {throw 'Recorded child identity changed; refusing to stop'}
      Stop-Process -Id $process.Id
      $process.WaitForExit()
    }
    Remove-Item $ChildState
  }
  if ($Action -eq 'uninstall') {Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false}
} elseif ($Action -eq 'run') {
  Set-Location $Root
  $env:BRI_SUPERVISOR_HOST='waiting-for-connection'
  $env:BRI_PORT='8791'
  $env:BRI_DB=Join-Path $Root 'var\state.db'
  $env:BRI_DISABLE_REMOTE='0'
  Log "supervisor started pid=$PID"
  $lock=$null
  try {
  $lock=[System.IO.File]::Open((Join-Path $Root 'var\controller-service.lock'),[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)
  for ($attempt=1; $attempt -le 5; $attempt++) {
    $waitingLogged=$false
    # Do not replace an existing Controller or interfere with another listener.
    while ($true) {
      $listener=Get-NetTCPConnection -LocalPort 8791 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if (!$listener) {break}
      $existing=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
      if ($existing.Name -ne 'node.exe' -or $existing.CommandLine -notmatch 'apps[/\\]controller[/\\]src[/\\]server.ts') {throw 'Port 8791 occupied by unrelated process'}
      if (!$waitingLogged) {Log "waiting for existing Controller pid=$($existing.ProcessId)"; $waitingLogged=$true}
      Start-Sleep -Seconds 5
    }
    $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
    $child=Start-Process -FilePath $Node -ArgumentList '--enable-source-maps','apps/controller/src/server.ts' -WorkingDirectory $Root -RedirectStandardOutput (Join-Path $Root "var\controller-service-$stamp.out") -RedirectStandardError (Join-Path $Root "var\controller-service-$stamp.err") -PassThru -NoNewWindow
    $handle=$child.Handle # Retain the handle so ExitCode stays readable after exit.
    @{pid=$child.Id;startTicks=[string]$child.StartTime.ToUniversalTime().Ticks}|ConvertTo-Json -Compress|Set-Content $ChildState
    Log "controller started pid=$($child.Id) attempt=$attempt"
    $child.WaitForExit()
    $exitCode=if ($null -eq $child.ExitCode) {'unknown'} else {$child.ExitCode}
    Log "controller exited pid=$($child.Id) exitCode=$exitCode"
    Remove-Item $ChildState -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 10
  }
  Log 'restart limit reached; needs inspection'
  exit 1
  } catch {
    Log "supervisor error: $($_.Exception.Message)"
    throw
  } finally {
    if ($lock) {$lock.Dispose()}
    Log "supervisor leaving pid=$PID"
  }
}
$task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  $info=Get-ScheduledTaskInfo -TaskName $TaskName
  [pscustomobject]@{TaskName=$task.TaskName;State=[string]$task.State;LastTaskResult=$info.LastTaskResult;LastRunTime=$info.LastRunTime}|ConvertTo-Json -Compress
}
