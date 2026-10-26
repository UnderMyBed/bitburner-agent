# install-brain-task.ps1 -DataDir <dir> [-Uninstall] [-WhatIf]  (npm run setup:windows -- -DataDir <dir>)
# Registers one Windows Task Scheduler task, "bitburner-agent brain", for the current user (#95): at logon it runs
# run-brain.ps1, which runs the brain and restarts it after any exit. The brain launches the game itself (#94), so
# there's no second task for the game. Running it again replaces the task (one task, never two); -Uninstall removes
# it; -WhatIf prints what it would do and changes nothing.
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $DataDir,
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
$taskName = 'bitburner-agent brain'

if ($Uninstall) {
    if ($PSCmdlet.ShouldProcess($taskName, 'Remove the scheduled task')) {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Write-Output "Removed the task '$taskName'."
        } else {
            Write-Output "There's no task '$taskName' to remove."
        }
    }
    exit 0
}

if (-not $DataDir) {
    Write-Error '-DataDir <dir> is required: where the brain keeps its data (a non-system drive, ADR 0006).'
    exit 2
}
# The task runs from elsewhere, so the data directory must be absolute.
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$runBrain = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-brain.ps1'))
$checkout = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
# The PowerShell running this one: the task needs PowerShell 7 too.
$shell = (Get-Process -Id $PID).Path
$user = "$env:USERDOMAIN\$env:USERNAME"
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runBrain`" -DataDir `"$DataDir`""

# These only describe the task; nothing changes until it's registered.
$action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $checkout
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Write-Output "Task: $taskName"
Write-Output "Trigger: at logon of $user"
Write-Output "Action: $shell $arguments"
Write-Output "Working directory: $checkout"
Write-Output 'Settings: no time limit; runs on battery; one instance at a time'

if ($PSCmdlet.ShouldProcess($taskName, 'Register the scheduled task')) {
    # -Force replaces a task of the same name: running this again leaves one task.
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Force | Out-Null
    Write-Output "Registered. It starts at your next logon; to start it now: Start-ScheduledTask -TaskName '$taskName'"
}
