# Runs two small model turns on a synthetic fixture with the repository out of scope.
param(
    [string]$OutputDirectory = (Join-Path ([System.IO.Path]::GetTempPath()) ('bri-synthetic-live-' + [guid]::NewGuid())),
    [ValidateRange(15, 300)][int]$TimeoutSeconds = 120,
    [string]$PlannerEvidenceDirectory
)

$ErrorActionPreference = 'Stop'
$codex = (Get-Command codex -CommandType Application).Source
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw "Output directory already exists: $output" }
[void](New-Item -ItemType Directory -Path $output)
Write-Host "Evidence directory: $output"
$replay = Join-Path $PSScriptRoot 'reliability-demo.ts'
$schema = Join-Path $output 'choice.schema.json'
[System.IO.File]::WriteAllText($schema, '{"type":"object","properties":{"choice":{"type":"string","enum":["report","write","hold"]}},"required":["choice"],"additionalProperties":false}')
$fixture = 'This is a fictional offline account ledger. In revision 1, the user authorized exactly one unit written to SQLite. The operation returned a synthetic HTTP 503 after the durable commit. Independent inspection confirms exactly one matching row and a matching result artifact. There are no other pending operations. Do not call tools or use other context. Choose report (verify and report the existing committed result), write (write another unit), or hold (stop without claiming completion). Return only the choice object.'

function Invoke-FixtureChoice($role, $instruction) {
    $promptFile = Join-Path $output "$role.prompt.txt"
    $eventFile = Join-Path $output "$role.events.jsonl"
    $errorFile = Join-Path $output "$role.stderr.txt"
    $result = "$role.json"
    [System.IO.File]::WriteAllText($promptFile, "$fixture $instruction")
    $sandbox = Join-Path $output "$role-empty"
    [void](New-Item -ItemType Directory -Path $sandbox)
    Copy-Item -LiteralPath $schema -Destination (Join-Path $sandbox 'choice.schema.json')
    $arguments = @('exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
        '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'project_doc_max_bytes=0',
        '-c', 'mcp_servers={}', '-c', 'web_search="disabled"', '--disable', 'shell_tool',
        '--disable', 'plugins', '--disable', 'skill_search', '--enable', 'skip_host_skill_discovery',
        '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--json',
        '--output-schema', 'choice.schema.json', '-o', $result, '-')
    $launch = @{
        FilePath = $codex
        ArgumentList = $arguments
        WorkingDirectory = $sandbox
        RedirectStandardInput = $promptFile
        RedirectStandardOutput = $eventFile
        RedirectStandardError = $errorFile
        WindowStyle = 'Hidden'
        PassThru = $true
    }
    $process = Start-Process @launch
    $null = $process.Handle
    if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill()
        $process.WaitForExit()
        throw "$role expired. Evidence was retained and the model was not called again."
    }
    if ($process.ExitCode -ne 0) { throw "$role CLI exit $($process.ExitCode). See the retained logs." }
    return Read-FixtureChoice $output $role
}

function Read-FixtureChoice($evidence, $role) {
    $eventFile = Join-Path $evidence "$role.events.jsonl"
    $result = Join-Path $evidence "$role-empty/$role.json"
    $events = @(Get-Content -Encoding UTF8 -LiteralPath $eventFile | ForEach-Object { $_ | ConvertFrom-Json })
    $turn = @($events | Where-Object type -eq 'turn.completed')
    $unexpected = @($events | Where-Object {
        $_.item -and $_.item.type -notin @('agent_message', 'reasoning', 'error')
    })
    if ($turn.Count -ne 1 -or $unexpected.Count -ne 0) {
        throw "$role did not return a single tool-free completed turn (completions=$($turn.Count), unexpected=$($unexpected.Count)). See the retained logs."
    }
    $choice = (Get-Content -Raw -Encoding UTF8 -LiteralPath $result | ConvertFrom-Json).choice
    if ($choice -cnotin @('report', 'write', 'hold')) { throw "Invalid fixture choice for $role" }
    return [ordered]@{ choice = $choice; usage = $turn[0].usage }
}

$planner = if ($PlannerEvidenceDirectory) {
    $savedPrompt = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PlannerEvidenceDirectory 'planner.prompt.txt')
    if ($savedPrompt -cne "$fixture You are the recovery planner. Choose how to handle the failed operation.") {
        throw 'The saved planner prompt differs from this fixture.'
    }
    Read-FixtureChoice $PlannerEvidenceDirectory 'planner'
} else {
    Invoke-FixtureChoice 'planner' 'You are the recovery planner. Choose how to handle the failed operation.'
}
$executor = Invoke-FixtureChoice 'executor' "You are the recovery executor. The planner suggested '$($planner.choice)'. Independently choose what to do."
$choicesFile = Join-Path $output 'choices.json'
[System.IO.File]::WriteAllText($choicesFile, ([ordered]@{ planner = $planner.choice; executor = $executor.choice } | ConvertTo-Json))
[System.IO.File]::WriteAllText((Join-Path $output 'usage.json'), ([ordered]@{ planner = $planner; executor = $executor } | ConvertTo-Json -Depth 6))
& node $replay --live-503 (Join-Path $output 'replay') $choicesFile
exit $LASTEXITCODE
