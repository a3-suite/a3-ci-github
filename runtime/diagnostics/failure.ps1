function Write-CiFailureEvidence {
  param([string]$Subject, [string]$Operation, [string]$Stage, [string]$LastConfirmed, [string]$WriteState, $NativeExit, [hashtable]$Comparison)
  $evidence = [ordered]@{
    classification = @{ subject = $Subject; operation = $Operation; stage = $Stage; reason = "$Stage-failed"; cause = 'unavailable' }
    context = @{ run = $env:GITHUB_RUN_ID; job = $env:GITHUB_JOB; platform = $env:RUNNER_OS; arch = $env:RUNNER_ARCH; input = $Stage; values = 'protected-or-unavailable' }
    comparison = $(if ($Comparison) { $Comparison } else { @{ field = $Stage; expected = 'contract-satisfied'; observed = 'failure'; values = 'protected-or-unavailable' } })
    'evidence-location' = @{ log = 'stderr'; artifact = 'not-generated' }
    'execution-state' = @{ outcome = 'failure'; lastConfirmed = $LastConfirmed; write = $WriteState; nativeExit = $(if ($null -eq $NativeExit) { 'unavailable' } else { $NativeExit }); rollback = 'unavailable' }
    'next-check' = @{ rule = $Stage; input = $Stage }
  }
  try { [Console]::Error.WriteLine('ci-failure-diagnostic:' + ($evidence | ConvertTo-Json -Depth 5 -Compress)) } catch { }
}
