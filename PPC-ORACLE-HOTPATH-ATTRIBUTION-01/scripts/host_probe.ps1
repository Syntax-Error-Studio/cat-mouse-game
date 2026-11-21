param([int]$SelfPid)

$os = Get-CimInstance Win32_OperatingSystem
Write-Output ([math]::Round($os.TotalVisibleMemorySize / 1024, 1))
Write-Output ([math]::Round($os.FreePhysicalMemory / 1024, 1))

$all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")

# Build this process's ancestry so the runner's own CLI + pool worker are not
# mistaken for duplicate heavy workers.
$anc = New-Object 'System.Collections.Generic.HashSet[int]'
$cur = $SelfPid
$guard = 0
while ($cur -gt 0 -and $guard -lt 32) {
  [void]$anc.Add($cur)
  $p = $all | Where-Object { $_.ProcessId -eq $cur } | Select-Object -First 1
  if ($null -eq $p) {
    $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
    if ($null -eq $pp) { break }
    $cur = [int]$pp.ParentProcessId
  } else {
    $cur = [int]$p.ParentProcessId
  }
  $guard++
}

$vitest = @($all | Where-Object { $_.CommandLine -like '*vitest*' })
$outside = @($vitest | Where-Object { -not $anc.Contains([int]$_.ProcessId) })
$foreign = @($all | Where-Object { $_.CommandLine -notlike '*vitest*' })

Write-Output $vitest.Count
Write-Output $outside.Count
Write-Output $foreign.Count