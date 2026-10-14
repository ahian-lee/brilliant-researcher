param([switch]$SkipLegacy)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$Root=Split-Path $PSScriptRoot -Parent
$Evidence=Join-Path $Root ('var\dashboard-lifecycle-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory $Evidence|Out-Null
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$node=(Get-Command node.exe).Source
$probe=Join-Path $PSScriptRoot 'dashboardConsoleProbe.mjs'
$prefix='BRI-Dashboard-Lifecycle-'+(Get-Date -Format 'yyyyMMddHHmmss')
$names=@()
function Register-Probe([string]$Name,[string]$Execute,[string]$Arguments,[string]$Logon,[int]$Recovery=0){
 $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType $Logon -RunLevel Limited
 $action=New-ScheduledTaskAction -Execute $Execute -Argument $Arguments -WorkingDirectory $Root
 $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
 if($Recovery){
   $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(3) -RepetitionInterval (New-TimeSpan -Minutes 1)
   Register-ScheduledTask -TaskName $Name -Action $action -Principal $principal -Settings $settings -Trigger $trigger|Out-Null
 }else{
   Register-ScheduledTask -TaskName $Name -Action $action -Principal $principal -Settings $settings|Out-Null
   Start-ScheduledTask -TaskName $Name
 }
}
function Wait-Probe([int]$Port,[int]$Seconds=20){
 $until=(Get-Date).AddSeconds($Seconds)
 do{try{return Invoke-RestMethod "http://127.0.0.1:$Port/" -TimeoutSec 1}catch{Start-Sleep -Milliseconds 500}}while((Get-Date)-lt $until)
 throw "Probe $Port did not respond"
}
try{
 foreach($port in @(8894,8895)){if(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){throw "Probe port $port already occupied"}}
 $signalScript=Join-Path $PSScriptRoot 'dashboardConsoleSignal.ps1'
 if(!$SkipLegacy){
 $legacyState=Join-Path $Evidence 'legacy.json';$legacyName="$prefix-Legacy";$names+=$legacyName
 $legacy=Join-Path $PSScriptRoot 'dashboardLegacyConsoleProbe.ps1'
 Register-Probe $legacyName 'powershell.exe' "-NoProfile -WindowStyle Hidden -File `"$legacy`" -State `"$legacyState`" -Port 8894" 'Interactive'
 $before=Wait-Probe 8894
 Write-Output "Legacy probe ready pid=$($before.pid)"
 $signalProcess=Start-Process powershell.exe -ArgumentList @('-NoProfile','-File',('"'+$signalScript+'"'),'-Target',"$($before.pid)",'-State',('"'+$legacyState+'"')) -PassThru -Wait
 Start-Sleep -Seconds 2
 $legacyInfo=Get-ScheduledTaskInfo $legacyName
 $legacySignal=Get-Content "$legacyState.signal" -Raw|ConvertFrom-Json
 $legacyGone=!(Get-Process -Id $before.pid -ErrorAction SilentlyContinue)
 @{legacySignal=$legacySignal;gone=$legacyGone;lastResult=$legacyInfo.LastTaskResult}|ConvertTo-Json -Depth 6|Set-Content (Join-Path $Evidence 'legacy-result.json')
 Write-Output "Legacy after console signal: gone=$legacyGone taskResult=$($legacyInfo.LastTaskResult)"
 if(!$legacySignal.sent -or !$legacyGone -or $legacyInfo.LastTaskResult -ne 3221225786){throw 'Did not reproduce the observed console failure'}
 }
 $fixedState=Join-Path $Evidence 'console-free.json';$fixedName="$prefix-ConsoleFree";$names+=$fixedName
 $nativeHost=Join-Path $Evidence 'console-free-host.exe'
 $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
 $source=Join-Path $Root 'runner\DashboardWindowsHost.cs'
 $build=Start-Process $compiler -ArgumentList @('/nologo','/target:winexe',('/out:"'+$nativeHost+'"'),('"'+$source+'"')) -RedirectStandardOutput (Join-Path $Evidence 'build.out') -RedirectStandardError (Join-Path $Evidence 'build.err') -PassThru
 $buildHandle=$build.Handle;$build.WaitForExit()
 if($build.ExitCode -ne 0 -or !(Test-Path $nativeHost)){Get-Content (Join-Path $Evidence 'build.out');Get-Content (Join-Path $Evidence 'build.err');throw 'Host build failed'}
 $owner=Join-Path $Evidence 'console-free-owner.json'
 $arguments=(@($node,$probe,$fixedState,'8895',$owner,(Join-Path $Evidence 'host.log'),(Join-Path $Evidence 'host.out'),(Join-Path $Evidence 'host.err'))|ForEach-Object {'"'+$_+'"'}) -join ' '
 Register-Probe $fixedName $nativeHost $arguments 'Interactive' 1
 $fixed=Wait-Probe 8895
 $signalProcess=Start-Process powershell.exe -ArgumentList @('-NoProfile','-File',('"'+$signalScript+'"'),'-Target',"$($fixed.pid)",'-State',('"'+$fixedState+'"')) -PassThru -Wait
 $signal=Get-Content "$fixedState.signal" -Raw|ConvertFrom-Json
 $after=Wait-Probe 8895
 @{signal=$signal;pidBefore=$fixed.pid;pidAfter=$after.pid}|ConvertTo-Json -Depth 6|Set-Content (Join-Path $Evidence 'console-free-result.json')
 Write-Output "Console-free probe: pid=$($fixed.pid) attach=$($signal.attached) error=$($signal.attachError); still answering=$($after.pid)"
 if($signal.attached -or $signal.sent -or $after.pid -ne $fixed.pid){throw 'Console isolation was not demonstrated'}
 $owned=Get-CimInstance Win32_Process -Filter "ProcessId=$($fixed.pid)"
 if(!$owned.CommandLine.Contains($fixedState)){throw 'Probe identity changed; refusing failure injection'}
 Stop-Process -Id $fixed.pid -Force
 Write-Output 'Injected one unexpected probe process exit; waiting for the Windows recovery trigger (one minute).'
 $restarted=Wait-Probe 8895 90
 if($restarted.pid -eq $fixed.pid){throw 'Probe did not restart with a new PID'}
 @{oldPid=$fixed.pid;newPid=$restarted.pid;task=(Get-ScheduledTask $fixedName).State}|ConvertTo-Json|Set-Content (Join-Path $Evidence 'restart-result.json')
 Write-Output "Child failure restart passed: newPid=$($restarted.pid)"
 $parent=Get-Content $owner -Raw|ConvertFrom-Json
 $hostProcess=Get-Process -Id $parent.hostPid
 if([string]$hostProcess.StartTime.ToUniversalTime().Ticks -ne [string]$parent.hostStartTicks){throw 'Host identity changed'}
 $cim=Get-CimInstance Win32_Process -Filter "ProcessId=$($parent.hostPid)"
 if(!$cim.CommandLine.Contains($nativeHost)){throw 'Host does not belong to this probe'}
 Stop-Process -Id $parent.hostPid -Force
 Start-Sleep -Seconds 2
 if(Get-Process -Id $restarted.pid -ErrorAction SilentlyContinue){throw 'Parent exit orphaned the Node child'}
 Write-Output 'Killed only the GUI host: the owned Node child also exited. Waiting for Windows restart.'
 $afterParentFailure=Wait-Probe 8895 90
 if($afterParentFailure.pid -eq $restarted.pid){throw 'No new child after host failure'}
 @{oldHost=$parent.hostPid;oldChild=$restarted.pid;newChild=$afterParentFailure.pid}|ConvertTo-Json|Set-Content (Join-Path $Evidence 'parent-failure-result.json')
 Write-Output "Parent failure restart passed: newPid=$($afterParentFailure.pid)"
 Disable-ScheduledTask $fixedName|Out-Null
 Stop-ScheduledTask $fixedName
 Start-Sleep -Seconds 2
 if(Get-Process -Id $afterParentFailure.pid -ErrorAction SilentlyContinue){throw 'Explicit stop left the child alive'}
 if(Get-NetTCPConnection -LocalPort 8895 -State Listen -ErrorAction SilentlyContinue){throw 'Explicit stop left the port occupied'}
 Write-Output 'Explicit stop released the child and port; verifying it remains stopped across a recovery tick.'
 Start-Sleep -Seconds 20
 Start-Sleep -Seconds 20
 Start-Sleep -Seconds 25
 if(Get-NetTCPConnection -LocalPort 8895 -State Listen -ErrorAction SilentlyContinue){throw 'Explicitly stopped task restarted'}
 @{stopped=$true;portReleased=$true;stillStoppedAfter65Seconds=$true;task=[string](Get-ScheduledTask $fixedName).State;lastResult=(Get-ScheduledTaskInfo $fixedName).LastTaskResult}|ConvertTo-Json|Set-Content (Join-Path $Evidence 'stop-result.json')
 Write-Output "All lifecycle checks passed; evidence=$Evidence"
}catch{
 foreach($name in $names){
   Get-ScheduledTaskInfo $name -ErrorAction SilentlyContinue|Select-Object TaskName,LastRunTime,LastTaskResult,NextRunTime,NumberOfMissedRuns|ConvertTo-Json|Set-Content (Join-Path $Evidence ($name+'-failure.json'))
   Export-ScheduledTask $name -ErrorAction SilentlyContinue|Set-Content (Join-Path $Evidence ($name+'-failure.xml'))
 }
 throw
}finally{
 foreach($name in $names){Stop-ScheduledTask $name -ErrorAction SilentlyContinue;Unregister-ScheduledTask $name -Confirm:$false -ErrorAction SilentlyContinue}
}
