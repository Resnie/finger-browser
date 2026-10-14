# One-time recovery for the published Windows 0.2.0 uninstaller. Never deletes
# application directories or AppData, and never terminates browser processes.
$ErrorActionPreference = 'Stop'
$legacyHash = 'caeeff9b48f38439556fd8f344dfddc4358c4b6267323399deddb21e7f8547c6'
$root = [IO.Path]::GetFullPath($env:FINGER_LEGACY_ROOT).TrimEnd('\')
$expected = [IO.Path]::GetFullPath($env:FINGER_LEGACY_EXPECTED).TrimEnd('\')
$receiptFile = $env:FINGER_LEGACY_RECEIPT
$registryPaths = @('SOFTWARE\fingerbrowser', 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\fingerbrowser')
$hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)

function AssertRoot {
    if ($root -ne $expected -or [IO.Path]::GetFileName($root) -ne 'fingerbrowser') { throw 'Unsupported installation directory' }
    if ((Test-Path -LiteralPath $root) -and ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation directory is a link' }
}
function AssertLegacy($folder) {
    $exe = Join-Path $folder 'fingerbrowser.exe'
    if (!(Test-Path -LiteralPath $exe) -or (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower() -ne $legacyHash) { throw 'Unsupported legacy application' }
}
function SaveReceipt($value) {
    [IO.File]::WriteAllText($receiptFile, ($value | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
}
function ReadReceipt {
    $value = [IO.File]::ReadAllText($receiptFile) | ConvertFrom-Json
    if ($value.root -ne $root -or [IO.Path]::GetDirectoryName($value.backup) -ne [IO.Path]::GetDirectoryName($root) -or [IO.Path]::GetFileName($value.backup) -notmatch '^fingerbrowser\.previous-0\.2\.0-[a-f0-9]{32}$') { throw 'Invalid upgrade receipt' }
    return $value
}

try {
    AssertRoot
    switch ($env:FINGER_LEGACY_PHASE) {
        'stage' {
            AssertLegacy $root
            if (Get-Process fingerbrowser -ErrorAction SilentlyContinue) { throw 'Save and close Finger Browser before upgrading' }
            $native = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' AND CommandLine LIKE '%finger-browser%' AND CommandLine LIKE '%browser-data%'" -ErrorAction Stop)
            if ($native.Count -gt 0) { throw 'Save and close managed browser windows before upgrading' }
            $uninstall = $hive.OpenSubKey($registryPaths[1])
            if (!$uninstall -or $uninstall.GetValue('DisplayVersion') -ne '0.2.0') { throw 'Unsupported legacy registration' }
            $uninstall.Dispose()
            $keys = @()
            foreach ($name in $registryPaths) {
                $key = $hive.OpenSubKey($name)
                $values = @()
                if ($key) {
                    foreach ($valueName in $key.GetValueNames()) {
                        $values += @{name=$valueName; value=$key.GetValue($valueName); kind=$key.GetValueKind($valueName).ToString()}
                    }
                    $key.Dispose()
                }
                $keys += @{name=$name; values=$values}
            }
            $backup = $root + '.previous-0.2.0-' + [Guid]::NewGuid().ToString('N')
            $receipt = @{root=$root; backup=$backup; registry=$keys; completed=$false}
            SaveReceipt $receipt
            [IO.Directory]::Move($root, $backup)
            Write-Output 'Legacy application preserved for upgrade'
        }
        'commit' {
            if (Test-Path -LiteralPath $receiptFile) {
                $receipt = ReadReceipt
                AssertLegacy $receipt.backup
                $version = (Get-Item -LiteralPath (Join-Path $root 'fingerbrowser.exe')).VersionInfo.ProductVersion
                if ($version -notmatch '^0\.2\.1(?:\.0)?$') { throw 'New application version not verified' }
                $receipt.completed = $true
                SaveReceipt $receipt
                [IO.File]::Copy($receiptFile, (Join-Path $receipt.backup 'upgrade-receipt.json'))
            }
        }
        'rollback' {
            if (Test-Path -LiteralPath $receiptFile) {
                $receipt = ReadReceipt
                if (!$receipt.completed -and (Test-Path -LiteralPath $receipt.backup)) {
                    AssertLegacy $receipt.backup
                    if (Test-Path -LiteralPath $root) {
                        [IO.Directory]::Move($root, ($root + '.failed-0.2.1-' + [Guid]::NewGuid().ToString('N')))
                    }
                    [IO.Directory]::Move($receipt.backup, $root)
                    foreach ($saved in $receipt.registry) {
                        if ($saved.name -notin $registryPaths) { throw 'Invalid registry receipt' }
                        $key = $hive.CreateSubKey($saved.name)
                        foreach ($entry in $saved.values) {
                            $kind = [Microsoft.Win32.RegistryValueKind]([Enum]::Parse([Microsoft.Win32.RegistryValueKind], $entry.kind))
                            $value = $entry.value
                            if ($kind -eq [Microsoft.Win32.RegistryValueKind]::DWord) { $value = [int]$value }
                            if ($kind -eq [Microsoft.Win32.RegistryValueKind]::QWord) { $value = [long]$value }
                            if ($kind -eq [Microsoft.Win32.RegistryValueKind]::Binary) { $value = [byte[]]$value }
                            if ($kind -eq [Microsoft.Win32.RegistryValueKind]::MultiString) { $value = [string[]]$value }
                            $key.SetValue($entry.name, $value, $kind)
                        }
                        $key.Dispose()
                    }
                    Write-Output 'Original application restored'
                }
            }
        }
        default { throw 'Unsupported upgrade phase' }
    }
    exit 0
} catch {
    Write-Output ('Legacy upgrade stopped: ' + $_.Exception.Message)
    exit 1
} finally {
    $hive.Dispose()
}
