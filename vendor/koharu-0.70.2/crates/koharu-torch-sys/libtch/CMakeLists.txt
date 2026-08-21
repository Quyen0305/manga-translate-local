cmake_minimum_required(VERSION 3.5 FATAL_ERROR)
project(tch)

find_package(Torch REQUIRED)

add_library(koharu-torch SHARED torch_api.cpp torch_api_generated.cpp)
target_link_libraries(koharu-torch "${TORCH_LIBRARIES}")
if(MSVC AND CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  # stb_image 2.21 emits unresolved SSE intrinsic symbols with clang-cl 22.
  # Model inference remains accelerated by libtorch/CUDA.
  target_compile_definitions(koharu-torch PRIVATE STBI_NO_SIMD)
endif()
set_property(TARGET koharu-torch PROPERTY CXX_STANDARD 17)
set_property(TARGET koharu-torch PROPERTY WINDOWS_EXPORT_ALL_SYMBOLS ON)
install(TARGETS koharu-torch DESTINATION .)
