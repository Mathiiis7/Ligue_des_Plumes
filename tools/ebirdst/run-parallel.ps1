# Lance N Rscript en parallele sur le meme script build-habitat-fractions.R
# avec sharding automatique. Chaque worker traite 1/N des pays.
# Cache partage via CACHE_DIR (pas de conflit car cache_file par pays).
#
# Usage : .\run-parallel.ps1 [-N 4]
# Recommande N=4 sur laptop 4-8 cores, N=8 sur workstation.

param(
    [int]$N = 4
)

$scriptPath = Join-Path $PSScriptRoot "build-habitat-fractions.R"
$rscript = "C:\Program Files\R\R-4.6.1\bin\Rscript.exe"

if (-not (Test-Path $rscript)) {
    Write-Error "Rscript introuvable a $rscript"
    exit 1
}

Write-Output "Lancement de $N workers en parallele..."
$processes = @()
for ($i = 0; $i -lt $N; $i++) {
    $shard = "$i/$N"
    $logFile = Join-Path $env:TEMP "habitat-shard-$i.log"
    Write-Output "  worker $i/$N -> log: $logFile"
    # PowerShell 5.1 : pas de -Environment sur Start-Process. On utilise
    # ProcessStartInfo qui expose EnvironmentVariables.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $rscript
    $psi.Arguments = "`"$scriptPath`""
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables["SHARD"] = $shard
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    # Redirection sortie -> fichier log en async
    $sb = [scriptblock]::Create("param(`$sender, `$e) if(`$e.Data){ Add-Content -Path '$logFile' -Value `$e.Data }")
    $p.add_OutputDataReceived($sb)
    $p.add_ErrorDataReceived($sb)
    if(Test-Path $logFile){ Remove-Item $logFile -Force }
    "" | Out-File -FilePath $logFile -Encoding UTF8
    $p.Start() | Out-Null
    $p.BeginOutputReadLine()
    $p.BeginErrorReadLine()
    $processes += $p
}

Write-Output "Tous les workers lances. PIDs :"
$processes | ForEach-Object { Write-Output "  PID $($_.Id)" }
Write-Output ""
Write-Output "Suivi progression :"
Write-Output "  Get-Content '$env:TEMP\habitat-shard-0.log' -Wait -Tail 10"
Write-Output "Ou compter les fichiers caches :"
Write-Output "  (Get-ChildItem 'C:\Users\mathi\Documents\Projets\clc\cache_frac' -Filter '*.tif').Count"
