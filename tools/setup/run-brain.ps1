# run-brain.ps1 -DataDir <dir>: runs the brain, and restarts it 10 s after it exits, for ever (#95). This loop, not
# Task Scheduler (whose restart-on-failure isn't reliable for a program that exits with an error code), keeps the brain
# up. The brain's output, and each restart, go to <dir>\brain.log.
#
# The scheduled task (install-brain-task.ps1) runs this at logon. To stop the brain for good, end the task, or this
# script's pwsh, not just node: otherwise it's back in 10 s.
param(
    [Parameter(Mandatory)] [string] $DataDir,
    [int] $RestartDelaySeconds = 10,
    # For tests: the script node runs instead of the brain, and how many runs before stopping (0: for ever).
    [string] $BrainScript = (Join-Path $PSScriptRoot '..\..\packages\brain\src\main.ts'),
    [int] $MaxRuns = 0
)

$ErrorActionPreference = 'Stop'
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$logFile = Join-Path $DataDir 'brain.log'
# From the checkout's root, as `npm run brain` runs it.
Set-Location (Join-Path $PSScriptRoot '..\..')

function Write-Log([string] $message) {
    Add-Content -Path $logFile -Value "$([DateTime]::UtcNow.ToString('o')) run-brain: $message"
}

$runs = 0
while ($MaxRuns -eq 0 -or $runs -lt $MaxRuns) {
    $runs++
    Write-Log "starting the brain (run $runs)"
    # Both of the brain's streams into the log. A failure to start node at all is an exit like any other.
    try {
        & node $BrainScript --data-dir $DataDir *>> $logFile
        $exitCode = $LASTEXITCODE
    } catch {
        Add-Content -Path $logFile -Value $_.Exception.Message
        $exitCode = -1
    }
    Write-Log "the brain exited with code $exitCode; restarting in $RestartDelaySeconds s"
    Start-Sleep -Seconds $RestartDelaySeconds
}
