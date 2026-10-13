[CmdletBinding()]
param([string]$PythonExe, [switch]$SkipInstall)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Live Teams recording requires native Windows.' }
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$Cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
$NodeVersion = & $Node --version
if ($LASTEXITCODE -ne 0 -or $NodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Node.js 22 or newer is required.' }
$VenvPython = Join-Path $Root 'backend\.venv\Scripts\python.exe'
if ($SkipInstall -and $PythonExe) {
    $Python = (Resolve-Path -LiteralPath $PythonExe).Path
} else {
    if (-not (Test-Path -LiteralPath $VenvPython)) {
        if ($PythonExe) { & $PythonExe -m venv (Join-Path $Root 'backend\.venv') }
        else { & py -3.12 -m venv (Join-Path $Root 'backend\.venv') }
        if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12, or pass -PythonExe with a compatible interpreter.' }
    }
    $Python = $VenvPython
}
if (-not $SkipInstall) {
    & $Npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    & $Python -m pip install -r (Join-Path $Root 'backend\requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Backend dependency setup failed.' }
}
& $Python -c 'import fastapi,uvicorn,truststore,pydantic_settings'
if ($LASTEXITCODE -ne 0) { throw 'Backend dependencies are missing; run setup without -SkipInstall.' }
Write-Output 'Backend dependencies available.'
$Ffmpeg = Join-Path $Root 'backend\third_party\ffmpeg\ffmpeg.exe'
if (-not (Test-Path -LiteralPath $Ffmpeg)) {
    $Destination = Split-Path $Ffmpeg -Parent
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $Archive = Join-Path $Destination 'ffmpeg-7.1.1-essentials_build.7z'
    $Expected = '92216e5b6b9e4e4163875a9d474ba32f1f2af625151c0e02011bf4a7daf5a959'
    if (-not (Test-Path -LiteralPath $Archive)) {
        Invoke-WebRequest -Uri 'https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.7z' -OutFile $Archive
    }
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw 'FFmpeg archive checksum mismatch; refusing to use it.' }
    $Extracted = Join-Path $Destination 'extracted'
    New-Item -ItemType Directory -Force -Path $Extracted | Out-Null
    $ExtractedOk = $false
    # Use Windows libarchive, not an unrelated GNU tar earlier on PATH.
    $WindowsTar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path -LiteralPath $WindowsTar) {
        & $WindowsTar -xf $Archive -C $Extracted
        $ExtractedOk = ($LASTEXITCODE -eq 0)
    }
    if (-not $ExtractedOk) {
        $SevenZip = Get-Command 7z.exe -ErrorAction SilentlyContinue
        if (-not $SevenZip) {
            $SevenZipPath = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
            if (-not (Test-Path -LiteralPath $SevenZipPath)) { throw 'Install 7-Zip if Windows tar cannot extract this pinned archive.' }
        } else { $SevenZipPath = $SevenZip.Source }
        & $SevenZipPath x $Archive ('-o' + $Extracted) -y | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'FFmpeg extraction failed.' }
    }
    $Candidates = @(Get-ChildItem -LiteralPath $Extracted -Filter ffmpeg.exe -File -Recurse)
    if ($Candidates.Count -ne 1) { throw 'Expected one FFmpeg executable in the verified archive.' }
    Copy-Item -LiteralPath $Candidates[0].FullName -Destination $Ffmpeg
}
& $Npm run verify:full-dev
if ($LASTEXITCODE -ne 0) { throw 'Full-dev safety checks failed.' }
& $Python (Join-Path $Root 'scripts\verify-full-dev-job.py')
if ($LASTEXITCODE -ne 0) { throw 'Windows backend ownership check failed.' }
& $Npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed.' }
& $Npm run build:dev
if ($LASTEXITCODE -ne 0) { throw 'Fixed dev build failed.' }
$Launch = @(
    '@echo off',
    ('set "MN_DEV_PYTHON=' + $Python + '"'),
    ('start "" /D "' + $Root + '" "' + (Join-Path $Root 'node_modules\electron\dist\electron.exe') + '" "' + (Join-Path $Root 'dev-notetaker.cjs') + '"'),
    ''
) -join "`r`n"
[IO.File]::WriteAllText((Join-Path $Root 'out\Start Dev.cmd'), $Launch, (New-Object Text.UTF8Encoding($false)))
Write-Output 'Build ready. Quit the installed Notetaker from its tray, then open out\Start Dev.cmd in Explorer.'
Write-Output 'The launcher privately reuses installed provider settings and preserves normal processing, storage and approval/email behaviour.'
Write-Output 'It does not install, publish or change Windows auto-start. No provider request is made by setup.'
