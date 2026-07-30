# Build script for Windows NSIS installer
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent (Split-Path -Parent $ElectronDir)

# Configuration
$BunVersion = "bun-v1.3.10"  # Pinned version for reproducible builds

Write-Host "=== Building Mkrate Windows Installer using electron-builder ===" -ForegroundColor Cyan

# Debug: System information
Write-Host ""
Write-Host "=== Debug: System Information ===" -ForegroundColor Magenta
Write-Host "OS: $([System.Environment]::OSVersion.VersionString)"
Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
Write-Host "Hostname: $env:COMPUTERNAME"
Write-Host "User: $env:USERNAME"
Write-Host "Temp: $env:TEMP"
Write-Host "Working Dir: $(Get-Location)"

# Debug: Check Windows Defender status
Write-Host ""
Write-Host "=== Debug: Windows Defender Status ===" -ForegroundColor Magenta
try {
    $defenderStatus = Get-MpComputerStatus -ErrorAction SilentlyContinue
    if ($defenderStatus) {
        Write-Host "Real-time Protection: $($defenderStatus.RealTimeProtectionEnabled)"
        Write-Host "Antivirus Enabled: $($defenderStatus.AntivirusEnabled)"
        Write-Host "On Access Protection: $($defenderStatus.OnAccessProtectionEnabled)"
        Write-Host "IO AV Protection: $($defenderStatus.IoavProtectionEnabled)"
    } else {
        Write-Host "Could not get Defender status"
    }
} catch {
    Write-Host "Defender status check failed: $_"
}

# Debug: List exclusions
Write-Host ""
Write-Host "=== Debug: Defender Exclusions ===" -ForegroundColor Magenta
try {
    $prefs = Get-MpPreference -ErrorAction SilentlyContinue
    if ($prefs.ExclusionPath) {
        Write-Host "Path Exclusions: $($prefs.ExclusionPath -join ', ')"
    }
    if ($prefs.ExclusionProcess) {
        Write-Host "Process Exclusions: $($prefs.ExclusionProcess -join ', ')"
    }
} catch {
    Write-Host "Could not get exclusions: $_"
}
Write-Host ""

# 0. Do not signal existing processes. Hosted release runners are expected to be
# clean; local invocations must fail/retry around file locks rather than kill
# unrelated development Electron/Node/Bun processes.
Write-Host "Skipping process termination; build script will not signal existing processes."

# 1. Clean previous build artifacts (with retry for locked files)
Write-Host "Cleaning previous builds..."
$foldersToClean = @(
    "$ElectronDir\vendor",
    "$ElectronDir\node_modules\@anthropic-ai",
    "$ElectronDir\packages",
    "$ElectronDir\release"
)
foreach ($folder in $foldersToClean) {
    if (Test-Path $folder) {
        $retries = 3
        for ($i = 1; $i -le $retries; $i++) {
            try {
                Remove-Item -Recurse -Force $folder -ErrorAction Stop
                break
            } catch {
                if ($i -eq $retries) { throw }
                Write-Host "  Retrying cleanup of $folder (attempt $i)..." -ForegroundColor Yellow
                Start-Sleep -Seconds 2
            }
        }
    }
}

# 2. Install dependencies
Write-Host "Installing dependencies from the committed lockfile..."
Push-Location $RootDir
try {
    bun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "Frozen dependency install failed" }
    Write-Host "Running host-native sharp smoke..."
    bun test scripts/__tests__/sharp-native-smoke.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Host-native sharp smoke failed" }
} finally {
    Pop-Location
}

# 3. Download Bun binary for Windows
# Use baseline build - works on all x64 CPUs (no AVX2 requirement)
Write-Host "Downloading Bun $BunVersion for Windows x64 (baseline)..."
New-Item -ItemType Directory -Force -Path "$ElectronDir\vendor\bun" | Out-Null

$BunDownload = "bun-windows-x64-baseline"
$TempDir = Join-Path $env:TEMP "bun-download-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

try {
    # Download binary and checksums
    $ZipUrl = "https://github.com/oven-sh/bun/releases/download/$BunVersion/$BunDownload.zip"
    $ChecksumUrl = "https://github.com/oven-sh/bun/releases/download/$BunVersion/SHASUMS256.txt"

    Write-Host "Downloading from $ZipUrl..."
    Invoke-WebRequest -Uri $ZipUrl -OutFile "$TempDir\$BunDownload.zip"
    Invoke-WebRequest -Uri $ChecksumUrl -OutFile "$TempDir\SHASUMS256.txt"

    # Verify checksum
    Write-Host "Verifying checksum..."
    $ExpectedHash = (Get-Content "$TempDir\SHASUMS256.txt" | Select-String "$BunDownload.zip").ToString().Split(" ")[0]
    $ActualHash = (Get-FileHash "$TempDir\$BunDownload.zip" -Algorithm SHA256).Hash.ToLower()

    if ($ActualHash -ne $ExpectedHash) {
        throw "Checksum verification failed! Expected: $ExpectedHash, Got: $ActualHash"
    }
    Write-Host "Checksum verified successfully" -ForegroundColor Green

    # Extract and install using robocopy for better file handle management
    Write-Host "Extracting Bun..."
    Expand-Archive -Path "$TempDir\$BunDownload.zip" -DestinationPath $TempDir -Force

    # Unblock in temp first (before copy)
    Unblock-File -Path "$TempDir\$BunDownload\bun.exe" -ErrorAction SilentlyContinue

    # Use robocopy with retries - handles transient file locks better than Copy-Item
    # /R:5 = 5 retries, /W:3 = 3 second wait between retries, /NP = no progress, /NFL /NDL = quiet
    Write-Host "Copying bun.exe with robocopy..."
    $robocopyResult = robocopy "$TempDir\$BunDownload" "$ElectronDir\vendor\bun" "bun.exe" /R:5 /W:3 /NP /NFL /NDL
    # Robocopy exit codes: 0-7 are success, 8+ are errors
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed with exit code $LASTEXITCODE"
    }

    $BunExePath = "$ElectronDir\vendor\bun\bun.exe"
    Write-Host "Bun extracted to: $BunExePath" -ForegroundColor Green

    # Give Windows time to release any file handles from the copy
    Write-Host "Waiting for file handles to release..."
    Start-Sleep -Seconds 3
} finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

# 3a. Provision the target uv runtime required by packaged document tools.
Push-Location $RootDir
try {
    bun run scripts/prepare-electron-uv.ts win32 x64
    if ($LASTEXITCODE -ne 0) {
        throw "Bundled uv bootstrap failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
$UvPath = "$ElectronDir\resources\bin\win32-x64\uv.exe"
if (-not (Test-Path $UvPath)) {
    throw "Bundled uv runtime not found at $UvPath"
}

# 4. Copy SDK from root node_modules (monorepo hoisting).
# Since SDK 0.2.113: thin core + per-platform binary package.
# See apps/electron/scripts/build-dmg.sh for the full rationale.
$SdkSource = "$RootDir\node_modules\@anthropic-ai\claude-agent-sdk"
if (-not (Test-Path $SdkSource)) {
    Write-Host "ERROR: SDK core not found at $SdkSource" -ForegroundColor Red
    Write-Host "Run 'bun install' from the repository root first."
    exit 1
}
Write-Host "Copying SDK core..."
New-Item -ItemType Directory -Force -Path "$ElectronDir\node_modules\@anthropic-ai" | Out-Null
Remove-Item -Recurse -Force "$ElectronDir\node_modules\@anthropic-ai\claude-agent-sdk" -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force $SdkSource "$ElectronDir\node_modules\@anthropic-ai\"

# 4a. Resolve the target arch's binary package (cross-fetch from npm if absent).
# Target arch is hard-coded x64 — Windows arm64 is not currently shipped.
$SdkBinPkg = "claude-agent-sdk-win32-x64"
$SdkBinSource = "$RootDir\node_modules\@anthropic-ai\$SdkBinPkg"
if (-not (Test-Path $SdkBinSource)) {
    Write-Host "Cross-arch build: $SdkBinPkg not in node_modules — fetching from npm..."
    $RootPackageJson = Get-Content (Join-Path $RootDir "package.json") -Raw | ConvertFrom-Json
    $SdkVersion = $RootPackageJson.dependencies.'@anthropic-ai/claude-agent-sdk'
    $PkgTmp = New-Item -ItemType Directory -Path ([System.IO.Path]::Combine($env:TEMP, [System.Guid]::NewGuid().ToString()))
    try {
        Push-Location $PkgTmp
        try {
            $SdkPackage = "@anthropic-ai/$SdkBinPkg"
            $PackResult = npm pack --json "$SdkPackage@$SdkVersion" | ConvertFrom-Json
            if (-not $PackResult.filename -or -not $PackResult.version) {
                throw "npm pack did not report an exact tarball filename and version"
            }
            $Tarball = Join-Path $PkgTmp $PackResult.filename
            if (-not (Test-Path $Tarball)) { throw "npm pack did not create $Tarball" }
            $Integrity = (npm view "$SdkPackage@$($PackResult.version)" dist.integrity).Trim()
            if ($Integrity -notmatch '^([a-zA-Z0-9-]+)-([A-Za-z0-9+/=]+)$') {
                throw "npm registry did not return a valid dist.integrity value"
            }
            $Algorithm = $Matches[1].ToUpperInvariant().Replace('-', '')
            $ExpectedDigest = $Matches[2]
            $ActualDigest = [Convert]::ToBase64String([System.Security.Cryptography.HashAlgorithm]::Create($Algorithm).ComputeHash([System.IO.File]::ReadAllBytes($Tarball)))
            if ($ActualDigest -ne $ExpectedDigest) {
                throw "npm tarball integrity mismatch for $Tarball"
            }
            tar -xzf $Tarball
        } finally {
            Pop-Location
        }
        New-Item -ItemType Directory -Force -Path $SdkBinSource | Out-Null
        Copy-Item -Recurse -Force "$PkgTmp\package\*" $SdkBinSource
    } finally {
        Remove-Item -Recurse -Force $PkgTmp -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path $SdkBinSource)) {
    Write-Host "ERROR: SDK native binary package ($SdkBinPkg) not found at $SdkBinSource" -ForegroundColor Red
    exit 1
}

Write-Host "Staging SDK native binary as claude-agent-sdk-binary alias..."
$AliasDest = "$ElectronDir\node_modules\@anthropic-ai\claude-agent-sdk-binary"
Remove-Item -Recurse -Force $AliasDest -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $AliasDest | Out-Null
Copy-Item -Recurse -Force "$SdkBinSource\*" $AliasDest

$BinPath = "$AliasDest\claude.exe"
if (-not (Test-Path $BinPath)) {
    Write-Host "ERROR: Native binary not found at $BinPath" -ForegroundColor Red
    exit 1
}
$BinSize = (Get-Item $BinPath).Length
if ($BinSize -lt 50000000) {
    Write-Host "ERROR: claude.exe is only $BinSize bytes (expected ~210 MB)" -ForegroundColor Red
    exit 1
}
Write-Host "  Native binary: $([math]::Round($BinSize / 1MB)) MB"

# 5. Copy ripgrep (sourced from @vscode/ripgrep since 0.2.113).
$RgSource = "$RootDir\node_modules\@vscode\ripgrep"
if (-not (Test-Path $RgSource) -or -not (Test-Path "$RgSource\bin\rg.exe")) {
    Write-Host "ERROR: @vscode/ripgrep not installed or postinstall did not run" -ForegroundColor Red
    Write-Host "Run 'bun install' and 'bun pm trust @vscode/ripgrep'."
    exit 1
}
Write-Host "Copying @vscode/ripgrep..."
New-Item -ItemType Directory -Force -Path "$ElectronDir\node_modules\@vscode" | Out-Null
Remove-Item -Recurse -Force "$ElectronDir\node_modules\@vscode\ripgrep" -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force $RgSource "$ElectronDir\node_modules\@vscode\"

# 6. Copy network interceptor sources (for Pi subprocess; Claude no longer
#    uses --preload — Phase 2 will move that to SDK hooks or a local proxy).
$InterceptorSource = "$RootDir\packages\shared\src\unified-network-interceptor.ts"
if (-not (Test-Path $InterceptorSource)) {
    Write-Host "ERROR: Interceptor not found at $InterceptorSource" -ForegroundColor Red
    exit 1
}
Write-Host "Copying interceptor (for Pi subprocess)..."
New-Item -ItemType Directory -Force -Path "$ElectronDir\packages\shared\src" | Out-Null
Copy-Item $InterceptorSource "$ElectronDir\packages\shared\src\"
foreach ($dep in @("interceptor-common.ts", "feature-flags.ts", "interceptor-request-utils.ts")) {
    $depPath = "$RootDir\packages\shared\src\$dep"
    if (Test-Path $depPath) {
        Copy-Item $depPath "$ElectronDir\packages\shared\src\"
    }
}

# 6a. Stage the exact target sharp runtime graph. node_modules is excluded from
# regular electron-builder files, so the helper creates the minimal closure
# consumed by required extraResources and writes a packaged identity manifest.
Write-Host "Staging sharp runtime for win32-x64..."
Push-Location $RootDir
try {
    bun run scripts/stage-sharp-runtime.ts stage win32 x64
    if ($LASTEXITCODE -ne 0) { throw "Sharp runtime staging failed" }
} finally {
    Pop-Location
}

# 6. Build Electron app
Write-Host "Building Electron app..."
Write-Host "  Running canonical bun run electron:build path..."
Push-Location $RootDir
try {
    bun run electron:build
    if ($LASTEXITCODE -ne 0) { throw "Canonical Electron build failed" }
} finally {
    Pop-Location
}

# 7. Package with electron-builder
Write-Host "Packaging app with electron-builder..."

# Debug: Show bun.exe file info
Write-Host ""
Write-Host "=== Debug: bun.exe File Info ===" -ForegroundColor Magenta
$BunExe = "$ElectronDir\vendor\bun\bun.exe"
if (Test-Path $BunExe) {
    $fileInfo = Get-Item $BunExe
    Write-Host "Path: $($fileInfo.FullName)"
    Write-Host "Size: $([math]::Round($fileInfo.Length / 1MB, 2)) MB"
    Write-Host "Created: $($fileInfo.CreationTime)"
    Write-Host "Modified: $($fileInfo.LastWriteTime)"
    Write-Host "Attributes: $($fileInfo.Attributes)"

    # Check Zone.Identifier (Mark of the Web)
    $zoneFile = "$BunExe`:Zone.Identifier"
    if (Test-Path $zoneFile -ErrorAction SilentlyContinue) {
        Write-Host "Zone.Identifier: EXISTS (file may be blocked)" -ForegroundColor Yellow
    } else {
        Write-Host "Zone.Identifier: None (file is unblocked)"
    }

    # Check file hash
    $hash = (Get-FileHash $BunExe -Algorithm SHA256).Hash
    Write-Host "SHA256: $hash"
} else {
    Write-Host "ERROR: bun.exe not found at $BunExe" -ForegroundColor Red
}

# Debug: List vendor directory contents
Write-Host ""
Write-Host "=== Debug: vendor/bun Directory ===" -ForegroundColor Magenta
Get-ChildItem "$ElectronDir\vendor\bun" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  $($_.Name) - $($_.Length) bytes"
}

# Debug: Check for processes that might have files open
Write-Host ""
Write-Host "=== Debug: Potentially Relevant Processes ===" -ForegroundColor Magenta
$relevantProcesses = Get-Process | Where-Object {
    $_.ProcessName -match 'node|npm|bun|electron|defender|antimalware|mpcmdrun'
} | Select-Object ProcessName, Id, CPU, WorkingSet64
if ($relevantProcesses) {
    $relevantProcesses | ForEach-Object {
        Write-Host "  $($_.ProcessName) (PID: $($_.Id)) - Memory: $([math]::Round($_.WorkingSet64 / 1MB, 1)) MB"
    }
} else {
    Write-Host "  No relevant processes found"
}
Write-Host ""

# NOTE: bun.exe is now copied via extraResources in electron-builder.yml
# This avoids EBUSY errors from the npm node module collector.
# See electron-builder.yml for details.

# Verify bun.exe is accessible (not locked by another process)
Write-Host "  Verifying $BunExe is accessible..."
$retryCount = 0
$maxRetries = 6
while ($retryCount -lt $maxRetries) {
    try {
        # Try to open the file exclusively to verify no other process has it locked
        $stream = [System.IO.File]::Open($BunExe, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        $stream.Close()
        $stream.Dispose()
        Write-Host "  File is accessible" -ForegroundColor Green
        break
    } catch {
        $retryCount++
        if ($retryCount -ge $maxRetries) {
            Write-Host "  WARNING: File may be locked after $maxRetries attempts, proceeding anyway..." -ForegroundColor Yellow
        } else {
            Write-Host "  File locked, waiting 5 seconds (attempt $retryCount/$maxRetries)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
        }
    }
}

# Force garbage collection to release any managed file handles
[System.GC]::Collect()
[System.GC]::WaitForPendingFinalizers()

# Run electron-builder with retry logic for EBUSY errors
Push-Location $ElectronDir
$maxBuilderRetries = 3
$builderRetry = 0
$builderSuccess = $false

while (-not $builderSuccess -and $builderRetry -lt $maxBuilderRetries) {
    $builderRetry++
    Write-Host "  electron-builder attempt $builderRetry of $maxBuilderRetries..." -ForegroundColor Cyan

    # Clean release directory before each attempt to avoid stale files
    if (Test-Path "$ElectronDir\release") {
        Write-Host "  Cleaning release directory before attempt..."
        Remove-Item -Recurse -Force "$ElectronDir\release" -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    npx electron-builder --win --x64 --publish never 2>&1 | Tee-Object -Variable builderOutput

    if ($LASTEXITCODE -eq 0) {
        $builderSuccess = $true
        Write-Host "  electron-builder succeeded on attempt $builderRetry" -ForegroundColor Green
    } else {
        Write-Host "  electron-builder failed with exit code $LASTEXITCODE" -ForegroundColor Yellow

        if ($builderRetry -lt $maxBuilderRetries) {
            Write-Host "  Waiting 10 seconds before retry..." -ForegroundColor Yellow

            Write-Host "  Not killing processes on retry; waiting for transient locks to clear..." -ForegroundColor Yellow
            Start-Sleep -Seconds 10
        }
    }
}

Pop-Location

if (-not $builderSuccess) {
    throw "electron-builder failed after $maxBuilderRetries attempts"
}

# 8. Verify the staged packaged app contains the exact target sharp runtime graph.
$PackagedAppRoot = "$ElectronDir\release\win-unpacked\resources\app"
Write-Host "Verifying packaged sharp runtime graph..."
Push-Location $RootDir
try {
    bun run scripts/stage-sharp-runtime.ts verify-packaged win32 x64 $PackagedAppRoot
    if ($LASTEXITCODE -ne 0) { throw "Packaged sharp runtime verification failed" }
} finally {
    Pop-Location
}

# 8. Verify the installer was built
$InstallerPath = Get-ChildItem -Path "$ElectronDir\release" -Filter "*.exe" | Select-Object -First 1

if (-not $InstallerPath) {
    Write-Host "ERROR: Installer not found in $ElectronDir\release" -ForegroundColor Red
    Write-Host "Contents of release directory:"
    Get-ChildItem "$ElectronDir\release"
    exit 1
}

# v0.0.1 intentionally has no Authenticode certificate. Fail closed if ambient
# credentials or a builder default ever produce a signed installer.
$Signature = Get-AuthenticodeSignature -FilePath $InstallerPath.FullName
if ($Signature.Status -ne 'NotSigned') {
    throw "Expected unsigned installer (Authenticode NotSigned), got $($Signature.Status): $($Signature.StatusMessage)"
}
Write-Host "Authenticode status: NotSigned (expected)" -ForegroundColor Yellow

Write-Host ""
Write-Host "=== Build Complete ===" -ForegroundColor Green
Write-Host "Installer: $($InstallerPath.FullName)"
Write-Host "Size: $([math]::Round($InstallerPath.Length / 1MB, 2)) MB"
