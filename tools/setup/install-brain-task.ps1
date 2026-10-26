#Requires -Version 7.2
# install-brain-task.ps1 -DataDir <absolute dir> [-Uninstall] [-WhatIf]  (npm run setup:windows -- -DataDir <dir>)
# Registers one Windows Task Scheduler task, "bitburner-agent brain", for the current user (#95): at logon it runs
# run-brain.ps1, which runs the brain and restarts it after any exit. The brain launches the game itself (#94), so
# there's no second task for the game. Running it again replaces the task (one task, never two); -Uninstall stops and
# removes it; -WhatIf prints what it would do and changes nothing.
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $DataDir,
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
$taskName = 'bitburner-agent brain'

if ($Uninstall) {
    if ($PSCmdlet.ShouldProcess($taskName, 'Stop and remove the scheduled task')) {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            # Stopping ends run-brain.ps1, so nothing restarts the brain. Removing a running task wouldn't stop it.
            Stop-ScheduledTask -TaskName $taskName
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Write-Output "Removed the task '$taskName'. If the brain's node is still running, end it as docs/setup.md says."
        } else {
            Write-Output "There's no task '$taskName' to remove."
        }
    }
    exit 0
}

if (-not $DataDir) {
    throw '-DataDir <dir> is required: where the brain keeps its data (a non-system drive, ADR 0006).'
}
# The task runs from elsewhere, so only an absolute path means the same directory there.
if (-not [System.IO.Path]::IsPathFullyQualified($DataDir)) {
    throw "-DataDir must be an absolute path, such as D:\bitburner-agent; '$DataDir' isn't."
}
# The task runs the PowerShell running this one (7.2 or later, see #Requires).
$powerShellPath = (Get-Process -Id $PID).Path
if ($powerShellPath -like '*\WindowsApps\*') {
    throw "This is PowerShell from the Microsoft Store ($powerShellPath), whose folder changes with each update and would break the task. Install PowerShell 7 with winget or the MSI, and run this from it."
}
$runBrainScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-brain.ps1'))
$checkout = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
# A backslash before a closing quote escapes it on a Windows command line, so trailing ones (D:\, D:\agent\) are doubled.
$quotedDataDir = '"' + ($DataDir -replace '\\+$', '$0$0') + '"'
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runBrainScript`" -DataDir $quotedDataDir"

# These only describe the task; nothing changes until it's registered.
$task = New-ScheduledTask `
    -Action (New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $checkout) `
    -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $taskUser) `
    -Principal (New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited) `
    -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Priority 4)
# Priority 4 is normal. The default, 7, is below normal, and Windows passes it on to node, Steam and the game.

# Read back from the task itself, so this shows what would be registered.
$taskSettings = $task.Settings
Write-Output "Task: $taskName"
Write-Output "Trigger: at logon of $($task.Triggers[0].UserId)"
Write-Output "Principal: $($task.Principal.UserId), logon type $($task.Principal.LogonType), run level $($task.Principal.RunLevel)"
Write-Output "Action: $($task.Actions[0].Execute) $($task.Actions[0].Arguments)"
Write-Output "Working directory: $($task.Actions[0].WorkingDirectory)"
Write-Output ("Settings: time limit $($taskSettings.ExecutionTimeLimit); priority $($taskSettings.Priority); " +
    "disallow start on battery $($taskSettings.DisallowStartIfOnBatteries); " +
    "stop on battery $($taskSettings.StopIfGoingOnBatteries); multiple instances $($taskSettings.MultipleInstances)")

if ($PSCmdlet.ShouldProcess($taskName, 'Register the scheduled task')) {
    # -Force replaces a task of the same name: running this again leaves one task.
    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
    Write-Output "Registered. It starts at your next logon; to start it now: Start-ScheduledTask -TaskName '$taskName'"
}
