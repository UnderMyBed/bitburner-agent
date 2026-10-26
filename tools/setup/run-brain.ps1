#Requires -Version 7.2
# run-brain.ps1 -DataDir <dir>: runs the brain, and restarts it 10 s after it exits, for ever (#95). This loop, not
# Task Scheduler (whose restart-on-failure isn't reliable for a program that exits with an error code), keeps the brain
# up. The brain's output, and each restart, go to <dir>\brain.log.
#
# The scheduled task (install-brain-task.ps1) runs this at logon. To stop the brain for good, stop the task (which ends
# this script) and then end the brain's node: see docs/setup.md, "Stopping the brain for good".
param(
    [Parameter(Mandatory)] [string] $DataDir,
    [int] $RestartDelaySeconds = 10,
    # For tests: the script node runs instead of the brain, and how many runs before stopping (0: for ever).
    [string] $BrainScript = (Join-Path $PSScriptRoot '..\..\packages\brain\src\main.ts'),
    [int] $MaxRuns = 0
)

$ErrorActionPreference = 'Stop'
# The brain writes UTF-8. Without this, its output is decoded with the console's code page (the OEM one, under the
# task) and non-ASCII text is garbled in the log.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$logFile = Join-Path $DataDir 'brain.log'
# From the checkout's root, as `npm run brain` runs it.
Set-Location (Join-Path $PSScriptRoot '..\..')

# Never fatal: a log that can't be written (locked by another program, a drive not there yet) mustn't end the loop.
function Write-Log([string] $message) {
    $line = "$([DateTime]::UtcNow.ToString('o')) run-brain: $message"
    try {
        Add-Content -Path $logFile -Value $line
    } catch {
        [Console]::Error.WriteLine("$line (not in the log: $($_.Exception.Message))")
    }
}

$brainRunCount = 0
while ($MaxRuns -eq 0 -or $brainRunCount -lt $MaxRuns) {
    $brainRunCount++
    # Any failure, even making the data directory (a drive not there yet at logon) or starting node at all, is an exit
    # like any other: the loop goes on.
    try {
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
        Write-Log "starting the brain (run $brainRunCount, node $nodePath)"
        # Both of the brain's streams into the log.
        & node $BrainScript --data-dir $DataDir *>> $logFile
        $exitCode = $LASTEXITCODE
    } catch {
        Write-Log "couldn't run the brain: $($_.Exception.Message)"
        $exitCode = -1
    }
    Write-Log "the brain exited with code $exitCode; restarting in $RestartDelaySeconds s"
    Start-Sleep -Seconds $RestartDelaySeconds
}
