fn main() {
    let version = if std::env::var_os("CARGO_FEATURE_CUDA").is_some() {
        // Koharu 0.70.2 resolves its CUDA 13.0 runtime dynamically.
        "13.0"
    } else {
        "cpu"
    };
    println!("cargo:rustc-env=MANGA_TRANSLATE_CUDA_BUILD_VERSION={version}");
}
