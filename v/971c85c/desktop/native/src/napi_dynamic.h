// Windows: an N-API addon cannot link against the host executable by name (it is node.exe in tests, daW3.exe —
// Electron — in the app; node-gyp solves this with a delay-load hook, MinGW has none). Instead every N-API
// function addon.cpp calls is looked up at first use in the process that loaded the addon. Included by addon.cpp
// after node_api.h on Windows only; a function missing here fails the link (undefined reference), never at runtime.
#pragma once
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

inline FARPROC d3NapiProc(const char* name) {
  static HMODULE exe = GetModuleHandleW(nullptr);
  FARPROC p = GetProcAddress(exe, name);
  if (!p) {  // a Node built as a shared library
    static HMODULE lib = GetModuleHandleW(L"libnode.dll");
    if (lib) p = GetProcAddress(lib, name);
  }
  return p;
}

// Each use expands to a lambda with its own cached pointer; the inner name is not re-expanded (self-reference).
#define D3_NAPI(n) ([] { static auto f = reinterpret_cast<decltype(&::n)>(reinterpret_cast<void*>(d3NapiProc(#n))); return f; }())

#define napi_create_array_with_length D3_NAPI(napi_create_array_with_length)
#define napi_create_arraybuffer D3_NAPI(napi_create_arraybuffer)
#define napi_create_double D3_NAPI(napi_create_double)
#define napi_create_function D3_NAPI(napi_create_function)
#define napi_create_object D3_NAPI(napi_create_object)
#define napi_create_string_utf8 D3_NAPI(napi_create_string_utf8)
#define napi_create_typedarray D3_NAPI(napi_create_typedarray)
#define napi_get_boolean D3_NAPI(napi_get_boolean)
#define napi_get_cb_info D3_NAPI(napi_get_cb_info)
#define napi_get_last_error_info D3_NAPI(napi_get_last_error_info)
#define napi_get_named_property D3_NAPI(napi_get_named_property)
#define napi_get_null D3_NAPI(napi_get_null)
#define napi_get_typedarray_info D3_NAPI(napi_get_typedarray_info)
#define napi_get_undefined D3_NAPI(napi_get_undefined)
#define napi_get_value_bool D3_NAPI(napi_get_value_bool)
#define napi_get_value_double D3_NAPI(napi_get_value_double)
#define napi_get_value_string_utf8 D3_NAPI(napi_get_value_string_utf8)
#define napi_has_named_property D3_NAPI(napi_has_named_property)
#define napi_is_exception_pending D3_NAPI(napi_is_exception_pending)
#define napi_is_typedarray D3_NAPI(napi_is_typedarray)
#define napi_set_element D3_NAPI(napi_set_element)
#define napi_set_named_property D3_NAPI(napi_set_named_property)
#define napi_throw_error D3_NAPI(napi_throw_error)
#define napi_typeof D3_NAPI(napi_typeof)
#endif  // _WIN32
