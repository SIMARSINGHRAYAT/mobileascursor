$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument '/c "c:\Users\Simar Singh Rayat\mobileascursor\run_companion.bat"' -WorkingDirectory "c:\Users\Simar Singh Rayat\mobileascursor"
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName "MobileAsCursorCompanion" -Action $action -Principal $principal -Force
Start-ScheduledTask -TaskName "MobileAsCursorCompanion"
Start-Sleep -Seconds 2
Get-ScheduledTask -TaskName "MobileAsCursorCompanion"
