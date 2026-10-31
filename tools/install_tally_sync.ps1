<#
  install_tally_sync.ps1 -- (re)creates the scheduled task "RES-EVO Tally Sheet Sync" for the current user:
  runs tools\sync_tally_sheets.ps1 at logon and every 15 minutes, hidden (conhost --headless), only while logged on
  (Drive for Desktop and Dropbox live in the user session).  Remove:  Unregister-ScheduledTask "RES-EVO Tally Sheet Sync"
#>
$ErrorActionPreference = 'Stop'
$name   = 'RES-EVO Tally Sheet Sync'
$script = Join-Path $PSScriptRoot 'sync_tally_sheets.ps1'
$user   = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
          -Argument ('--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"') `
          -WorkingDirectory $PSScriptRoot
$every  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$logon  = New-ScheduledTaskTrigger -AtLogOn -User $user
$set    = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
          -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$who    = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($every, $logon) -Settings $set -Principal $who `
  -Description 'Copies each pad Tally Sheet PDF from RES Dropbox _Pad Certs zips into Drive > EWS Billing > _Tally Sheets for the billing site Email Draft (755). Source: RES-EVO-Billing-Platform\tools.' | Out-Null
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State
