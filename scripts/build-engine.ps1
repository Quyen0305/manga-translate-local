param(
    [switch]$Cuda,
    [switch]$Check
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifest = Join-Path $projectRoot "engine\Cargo.toml"

if (-not (Test-Path (Join-Path $projectRoot "vendor\koharu\Cargo.toml"))) {
    & git -C $projectRoot submodule update --init --recursive
    if ($LASTEXITCODE -ne 0) { throw "Could not initialize the Koharu source submodule." }
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
if ($Cuda -and -not (Get-Command nvcc -ErrorAction SilentlyContinue)) {
    throw "nvcc is missing. Install the CUDA Toolkit or build without -Cuda."
}
if ($Cuda -and -not $env:NVCC_CCBIN) {
    $visualStudioRoots = @(
        "C:\Program Files\Microsoft Visual Studio\2022",
        "C:\Program Files (x86)\Microsoft Visual Studio\2022"
    )
    $cl = $visualStudioRoots |
        Where-Object { Test-Path $_ } |
        ForEach-Object { Get-ChildItem $_ -Filter cl.exe -File -Recurse -ErrorAction SilentlyContinue } |
        Where-Object { $_.FullName -like "*\bin\Hostx64\x64\cl.exe" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($cl) { $env:NVCC_CCBIN = $cl.FullName }
}
if ($Cuda -and -not $env:NVCC_CCBIN) {
    throw "cl.exe is missing. Install Visual Studio C++ Build Tools."
}

$cargoArgs = if ($Check) {
    @("check", "--manifest-path", $manifest)
} else {
    @("build", "--manifest-path", $manifest, "--release")
}
if ($Cuda) { $cargoArgs += @("--features", "cuda") }

& $cargoCommand @cargoArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $Check) {
    Write-Output "Built: $(Join-Path $projectRoot 'engine\target\release\manga-engine.exe')"
}
