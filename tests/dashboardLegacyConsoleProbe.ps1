param([string]$State, [int]$Port)
$ErrorActionPreference='Stop'
$node=(Get-Command node.exe).Source
$probe=Join-Path $PSScriptRoot 'dashboardConsoleProbe.mjs'
@{pid=$PID;startTicks=[string](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks}|ConvertTo-Json -Compress|Set-Content "$State.parent"
$child=Start-Process -FilePath $node -ArgumentList @(('"'+$probe+'"'),('"'+$State+'"'),"$Port") -NoNewWindow -PassThru
$handle=$child.Handle
$child.WaitForExit()
exit $child.ExitCode
