$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot 'build-lab-reconciler.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Lambda build failed.' }
$buildMetadata = Get-Content -LiteralPath (Join-Path $projectRoot 'build/lab-reconciler-artifact.json') -Raw | ConvertFrom-Json
$buildRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'build')) + [IO.Path]::DirectorySeparatorChar
$artifactPath = [IO.Path]::GetFullPath($buildMetadata.artifact)
$zipPath = [IO.Path]::GetFullPath($buildMetadata.zip)
if (!$artifactPath.StartsWith($buildRoot, [StringComparison]::OrdinalIgnoreCase) -or !$zipPath.StartsWith($buildRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Package paths must remain inside the project build directory.'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($artifactPath, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $false)
[ordered]@{ zip = $zipPath; bytes = (Get-Item -LiteralPath $zipPath).Length; handler = 'index.handler'; runtime = 'nodejs22.x'; architecture = 'x86_64' } | ConvertTo-Json -Compress
