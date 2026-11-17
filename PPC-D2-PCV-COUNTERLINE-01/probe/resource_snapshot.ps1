# PPC-D2-PCV-COUNTERLINE-01 / G0 resource + concurrency snapshot — READ-ONLY.
#
# Emits machine-readable KEY=VALUE lines for the admission gate, plus the
# inventory of any vitest / benchmark worker currently alive. It reads process
# and memory state only; it never terminates, suspends or reconfigures anything.
#
# Usage:  & ./PPC-D2-PCV-COUNTERLINE-01/probe/resource_snapshot.ps1 -Tag preflight

param([string]$Tag = "snapshot")

$os = Get-CimInstance Win32_OperatingSystem

"TAG=$Tag"
"CAPTURED_AT=" + (Get-Date -Format o)

# --- admission gate inputs -------------------------------------------------
"TOTAL_PHYS_MB=" + [math]::Round($os.TotalVisibleMemorySize / 1024)
"FREE_PHYS_MB=" + [math]::Round($os.FreePhysicalMemory / 1024)
"COMMIT_LIMIT_MB=" + [math]::Round($os.TotalVirtualMemorySize / 1024)
"FREE_COMMIT_MB=" + [math]::Round($os.FreeVirtualMemory / 1024)
"COMMITTED_MB=" + [math]::Round(($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / 1024)

$pf = @(Get-CimInstance Win32_PageFileUsage)
"PAGEFILE_ALLOCATED_MB=" + [math]::Round((($pf | Measure-Object -Property AllocatedBaseSize -Sum).Sum))
"PAGEFILE_USED_MB=" + [math]::Round((($pf | Measure-Object -Property CurrentUsage -Sum).Sum))

"PROCESS_COUNT=" + (Get-Process).Count
"CPU_LOAD_PCT=" + [math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average)

# --- concurrency inventory: is any heavy worker already running? -----------
$vitest = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -match 'vitest|jest|bench|mocha' })
"HEAVY_WORKER_COUNT=" + $vitest.Count
foreach ($v in $vitest) {
    "HEAVY_WORKER pid=$($v.ProcessId) ppid=$($v.ParentProcessId) cmd=" + ($v.CommandLine -replace '\s+', ' ')
}

# --- top consumers (context only; never acted upon) -----------------------
"TOP_CONSUMERS_BEGIN"
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 |
    ForEach-Object { "  $($_.ProcessName) pid=$($_.Id) ws=$([math]::Round($_.WorkingSet64/1MB))mb priv=$([math]::Round($_.PrivateMemorySize64/1MB))mb" }
"TOP_CONSUMERS_END"
