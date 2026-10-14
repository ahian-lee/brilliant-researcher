param(
  [ValidateSet('start','status','stop')][string]$Action='start',
  [int]$Port=8793,
  [string]$ConfigPath='',
  [string]$NodePath='',
  [switch]$RegisterAtLogon
)
$ErrorActionPreference='Stop'
$Root=Split-Path $PSScriptRoot -Parent
$TaskName="Brilliant-Researcher-Native-Runtime-$Port"
if($Action -eq 'status'){
  $task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if($task){$task | Select-Object TaskName,State | ConvertTo-Json -Compress}else{Write-Output 'No registered native runtime task'}
  exit
}
if($Action -eq 'stop'){
  Disable-ScheduledTask -TaskName $TaskName | Out-Null
  Stop-ScheduledTask -TaskName $TaskName
  exit
}
if(!$ConfigPath){$ConfigPath=Join-Path $Root 'var\native-runtime.local.json'}
if(!(Test-Path $ConfigPath)){throw 'Run npm run setup, then configure var/native-runtime.local.json first'}
$ConfigPath=(Resolve-Path $ConfigPath).Path
if(!$NodePath){$NodePath=(Get-Command node.exe -ErrorAction Stop).Source}
$NodePath=(Resolve-Path $NodePath).Path
$Entry=Join-Path $PSScriptRoot 'native-runtime-host.ts'
if(!$RegisterAtLogon){
  Write-Output 'Starting in this terminal. For an optional logon task, build dashboard-windows-host.exe and pass -RegisterAtLogon.'
  & $NodePath $Entry $ConfigPath $Port
  exit $LASTEXITCODE
}
$HostExe=Join-Path $Root 'var\dashboard-windows-host.exe'
if(!(Test-Path $HostExe)){throw 'Build runner/DashboardWindowsHost.cs as var/dashboard-windows-host.exe first, or use npm run runtime in a terminal'}
$State=Join-Path $Root "var\native-$Port-owner.json"
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments=(@($NodePath,$Entry,$ConfigPath,"$Port",$State,(Join-Path $Root "var\native-$Port-host.log"),(Join-Path $Root "var\native-$Port.stdout.log"),(Join-Path $Root "var\native-$Port.stderr.log"))|ForEach-Object{'"'+$_+'"'}) -join ' '
$task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if($task -and $task.State -eq 'Running'){Write-Output 'Native execution owner already running';exit}
$actionDef=New-ScheduledTaskAction -Execute $HostExe -Argument $arguments -WorkingDirectory $Root
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $actionDef -Trigger $trigger -Settings $settings -User $user -RunLevel Limited -Force | Out-Null
Enable-ScheduledTask -TaskName $TaskName | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output 'Brilliant Researcher native runtime logon task started without a terminal'
