param(
    [switch]$Cuda,
    [switch]$Check
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifest = Join-Path $projectRoot "engine\Cargo.toml"

if (-not (Test-Path (Join-Path $projectRoot "vendor\koharu-0.70.2\Cargo.toml"))) {
    throw "Koharu 0.70.2 source is missing from vendor\koharu-0.70.2."
}

$cargoCommand = (Get-Command cargo -ErrorAction SilentlyContinue).Source
if (-not $cargoCommand) {
    $userCargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
    if (Test-Path $userCargo) { $cargoCommand = $userCargo }
}
if (-not $cargoCommand) {
    throw "Rust is missing. Install rustup from https://rustup.rs and retry."
}

if (-not $env:LIBCLANG_PATH) {
    $clangCandidates = @(
        (Join-Path $env:LOCALAPPDATA "LLVM\bin"),
        "C:\Program Files\LLVM\bin"
    )
    $clang = $clangCandidates | Where-Object { Test-Path (Join-Path $_ "libclang.dll") } | Select-Object -First 1
    if ($clang) { $env:LIBCLANG_PATH = $clang }
}
if (-not $env:LIBCLANG_PATH) {
    throw "libclang.dll is missing. Install LLVM and retry."
}
if (-not (Test-Path (Join-Path $env:LIBCLANG_PATH "clang-cl.exe"))) {
    throw "clang-cl.exe is missing from LIBCLANG_PATH. Install a complete LLVM toolchain."
}

if (-not (Get-Command ninja -ErrorAction SilentlyContinue)) {
    $ninjaCandidates = @(
        "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja",
        "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja",
        "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja"
    )
    $ninja = $ninjaCandidates |
        Where-Object { Test-Path (Join-Path $_ "ninja.exe") } |
        Select-Object -First 1
    if ($ninja) { $env:PATH = "$ninja;$env:PATH" }
}
if (-not (Get-Command ninja -ErrorAction SilentlyContinue)) {
    throw "ninja.exe is missing. Install Ninja or Visual Studio CMake tools."
}
$env:PATH = "$env:LIBCLANG_PATH;$env:PATH"

$cargoArgs = if ($Check) {
    @("check", "--manifest-path", $manifest)
} else {
    @("build", "--manifest-path", $manifest, "--release")
}
if ($Cuda) { $cargoArgs += @("--features", "cuda") }

& $cargoCommand @cargoArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $Check) {
    Write-Output "Built: $(Join-Path $projectRoot 'engine\target\release\MangaTranslate.exe')"
}
