# Mkrate Windows Installer
# Usage: irm https://raw.githubusercontent.com/mkrtc/mkrate/main/scripts/install-app.ps1 | iex

& {
$ErrorActionPreference = "Stop"

# Default to GitHub Releases for this fork. Override for staging/custom feeds with:
#   $env:CRAFT_AGENTS_DOWNLOAD_BASE_URL = "https://example.com/path/to/latest/download"
if ($env:CRAFT_AGENTS_DOWNLOAD_BASE_URL) {
    $DOWNLOAD_BASE_URL = $env:CRAFT_AGENTS_DOWNLOAD_BASE_URL.TrimEnd('/')
} else {
    $DOWNLOAD_BASE_URL = "https://github.com/mkrtc/mkrate/releases/latest/download"
}
$DOWNLOAD_DIR = "$env:TEMP\mkrate-install"
$APP_NAME = "Mkrate"

# Colors for output
function Write-Info { Write-Host "> $args" -ForegroundColor Blue }
function Write-Success { Write-Host "> $args" -ForegroundColor Green }
function Write-Warn { Write-Host "! $args" -ForegroundColor Yellow }
function Write-Err { Write-Host "x $args" -ForegroundColor Red; exit 1 }

# Check for Windows
if ($env:OS -ne "Windows_NT") {
    Write-Err "This installer is for Windows only."
}

# Detect architecture
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
$platform = "win32-$arch"

Write-Host ""
Write-Info "Detected platform: $platform (arch: $arch)"

# Create download directory
New-Item -ItemType Directory -Force -Path $DOWNLOAD_DIR | Out-Null

# Fetch YAML manifest directly from the latest release assets.
Write-Info "Fetching release info..."
$yamlPath = Join-Path $DOWNLOAD_DIR "latest.yml"
try {
    Invoke-WebRequest -Uri "$DOWNLOAD_BASE_URL/latest.yml" -OutFile $yamlPath -UseBasicParsing
} catch {
    Write-Err "Failed to fetch release info: $_"
}

$yamlContent = Get-Content $yamlPath -Raw
if (-not $yamlContent) {
    Write-Err "Failed to fetch release info from latest.yml"
}

# Extract version from YAML manifest
$version = $null
if ($yamlContent -match '(?m)^version:\s*(.+)') {
    $version = $Matches[1].Trim()
}

if (-not $version) {
    Write-Err "Failed to extract version from manifest"
}

Write-Info "Latest version: $version"

# Parse YAML to extract sha512, url (filename), and size for our architecture.
# Supports both manifests with per-file `arch:` fields and standard
# electron-builder manifests that only contain a single files[] entry.
function Get-YamlEntryForArch {
    param([string]$yaml, [string]$targetArch)
    $lines = $yaml -split "`n"
    $currentUrl = $null
    $currentSha512 = $null
    $currentSize = $null
    $firstEntry = $null

    foreach ($line in $lines) {
        if ($line -match '^\s*-\s*url:\s*(.+)') {
            $currentUrl = $Matches[1].Trim()
            $currentSha512 = $null
            $currentSize = $null
        }
        if ($line -match '^\s*sha512:\s*(.+)') {
            $currentSha512 = $Matches[1].Trim()
            if (-not $firstEntry -and $currentUrl) {
                $firstEntry = @{ url = $currentUrl; sha512 = $currentSha512; size = $currentSize }
            }
        }
        if ($line -match '^\s*size:\s*(\d+)') {
            $currentSize = [long]$Matches[1]
            if ($firstEntry -and $firstEntry.url -eq $currentUrl) {
                $firstEntry.size = $currentSize
            }
        }
        if ($line -match '^\s*arch:\s*(.+)') {
            $entryArch = $Matches[1].Trim()
            if ($entryArch -eq $targetArch -and $currentSha512 -and $currentUrl) {
                return @{ url = $currentUrl; sha512 = $currentSha512; size = $currentSize }
            }
        }
    }
    return $firstEntry
}

$entry = Get-YamlEntryForArch -yaml $yamlContent -targetArch $arch

if (-not $entry) {
    Write-Err "No valid artifact entry found in latest.yml for architecture $arch"
}

$checksum = $entry.sha512
$filename = $entry.url
$fileSize = $entry.size

# Validate checksum format (SHA-512 base64 = 88 characters)
if (-not $checksum -or $checksum.Length -lt 80) {
    Write-Err "Invalid checksum in manifest"
}

# Use default filename if not found
if (-not $filename) {
    $filename = "Mkrate-$arch.exe"
}

$installerUrl = "$DOWNLOAD_BASE_URL/$filename"

Write-Info "Expected sha512: $($checksum.Substring(0, 20))..."

# Download installer with progress
$installerPath = Join-Path $DOWNLOAD_DIR $filename
$fileSizeMB = if ($fileSize -gt 0) { [math]::Round($fileSize / 1MB, 1) } else { 0 }

# Clean up any partial download from previous attempts
Remove-Item -Path $installerPath -Force -ErrorAction SilentlyContinue

Write-Info "Downloading $filename ($fileSizeMB MB)..."

try {
    # Use WebRequest for download with progress
    $webRequest = [System.Net.HttpWebRequest]::Create($installerUrl)
    $webRequest.Timeout = 600000  # 10 minutes
    $response = $webRequest.GetResponse()
    $responseStream = $response.GetResponseStream()
    $fileStream = [System.IO.File]::Create($installerPath)

    $buffer = New-Object byte[] 65536
    $totalRead = 0
    $lastPercent = -1

    while (($read = $responseStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $fileStream.Write($buffer, 0, $read)
        $totalRead += $read

        if ($fileSize -gt 0) {
            $percent = [math]::Floor(($totalRead / $fileSize) * 100)
            if ($percent -ne $lastPercent) {
                $downloadedMB = [math]::Round($totalRead / 1MB, 1)
                $barWidth = 40
                # Cap at 100% for display (actual download may exceed manifest size slightly)
                $displayPercent = [math]::Min($percent, 100)
                $filled = [math]::Min([math]::Floor($displayPercent / (100 / $barWidth)), $barWidth)
                $bar = "[" + ("#" * $filled) + ("-" * ($barWidth - $filled)) + "]"
                Write-Host -NoNewline ("`r  $bar $percent% ($downloadedMB / $fileSizeMB MB)   ")
                $lastPercent = $percent
            }
        }
    }

    $fileStream.Close()
    $responseStream.Close()
    $response.Close()

    Write-Host ""
    Write-Success "Download complete!"
} catch {
    # Clean up partial download on failure
    if ($fileStream) { $fileStream.Close() }
    if ($responseStream) { $responseStream.Close() }
    if ($response) { $response.Close() }
    Remove-Item -Path $installerPath -Force -ErrorAction SilentlyContinue
    Write-Err "Download failed: $_"
}

# Verify file was downloaded
if (-not (Test-Path $installerPath)) {
    Write-Err "Download failed: file not found"
}

# Verify checksum (SHA-512, base64 encoded — matches electron-builder YAML manifest)
Write-Info "Verifying checksum..."
$sha512 = [System.Security.Cryptography.SHA512]::Create()
$stream = [System.IO.File]::OpenRead($installerPath)
$hashBytes = $sha512.ComputeHash($stream)
$stream.Close()
$sha512.Dispose()
$actualHash = [Convert]::ToBase64String($hashBytes)

if ($actualHash -ne $checksum) {
    Remove-Item -Path $installerPath -Force -ErrorAction SilentlyContinue
    Write-Err "Checksum verification failed`n  Expected: $checksum`n  Actual:   $actualHash"
}

Write-Success "Checksum verified!"

# Close the app if it's running
$process = Get-Process -Name "Mkrate" -ErrorAction SilentlyContinue
if ($process) {
    Write-Info "Closing Mkrate..."
    $process | Stop-Process -Force
    Start-Sleep -Seconds 2
}

# Run the installer
Write-Info "Running installer (follow the installer prompts)..."

try {
    $installerProcess = Start-Process -FilePath $installerPath -PassThru
    $spinner = @('|', '/', '-', '\')
    $i = 0

    while (-not $installerProcess.HasExited) {
        Write-Host -NoNewline ("`r  Installing... " + $spinner[$i % 4] + "   ")
        Start-Sleep -Milliseconds 200
        $i++
    }

    Write-Host -NoNewline "`r                      `r"

    if ($installerProcess.ExitCode -ne 0) {
        Write-Err "Installation failed with exit code: $($installerProcess.ExitCode)"
    }
} catch {
    Write-Err "Installation failed: $_"
}

# Clean up installer
Write-Info "Cleaning up..."
Remove-Item -Path $installerPath -Force -ErrorAction SilentlyContinue

# Add command line shortcut
Write-Info "Adding 'mkrate' command to PATH..."

$binDir = "$env:LOCALAPPDATA\Mkrate\bin"
$cmdFile = "$binDir\mkrate.cmd"
$exePath = "$env:LOCALAPPDATA\Programs\Mkrate\Mkrate.exe"

# Create bin directory
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# Create batch file launcher
$cmdContent = "@echo off`r`nstart `"`" `"$exePath`" %*"
Set-Content -Path $cmdFile -Value $cmdContent -Encoding ASCII

# Add to user PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
    $newPath = "$userPath;$binDir"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Success "Added to PATH (restart terminal to use 'mkrate' command)"
} else {
    Write-Success "Command 'mkrate' is ready"
}

Write-Host ""
Write-Host "---------------------------------------------------------------------"
Write-Host ""
Write-Success "Installation complete!"
Write-Host ""
Write-Host "  Mkrate has been installed."
Write-Host ""
Write-Host "  Launch from:"
Write-Host "    - Start Menu or desktop shortcut"
Write-Host "    - Command line: mkrate (restart terminal first)"
Write-Host ""
}
