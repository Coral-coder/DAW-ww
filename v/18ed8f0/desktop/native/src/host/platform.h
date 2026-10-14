// Small OS layer for the plugin host: dynamic libraries, UTF-8 file paths, environment path lists.
// POSIX: dlopen / fopen. Windows: LoadLibraryExW / _wfopen with UTF-8 <-> UTF-16 conversion.
#pragma once
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace daw3 {

#ifdef _WIN32
constexpr char kPathListSep = ';';

inline std::wstring widen(const std::string& s) {
  if (s.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
  return w;
}

inline std::string narrow(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

/** Windows paths with forward slashes work everywhere in Win32 except LoadLibraryEx's altered search path. */
inline std::wstring winPath(const std::string& p) {
  std::wstring w = widen(p);
  for (auto& c : w) if (c == L'/') c = L'\\';
  return w;
}

inline std::string lastErrorText() {
  wchar_t* buf = nullptr;
  const DWORD code = GetLastError();
  FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, code, 0, (LPWSTR)&buf, 0, nullptr);
  std::string s = buf ? narrow(buf) : "error " + std::to_string(code);
  if (buf) LocalFree(buf);
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ' || s.back() == '.')) s.pop_back();
  return s;
}

inline void* dlOpen(const std::string& path, std::string& err) {
  // the plugin's own folder is searched for its dependent DLLs
  HMODULE h = LoadLibraryExW(winPath(path).c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (!h) err = "Could not load " + path + ": " + lastErrorText();
  return (void*)h;
}
inline void* dlSym(void* h, const char* name) { return h ? (void*)GetProcAddress((HMODULE)h, name) : nullptr; }
inline void dlClose(void* h) { if (h) FreeLibrary((HMODULE)h); }

inline FILE* fopenUtf8(const std::string& path, const char* mode) { return _wfopen(widen(path).c_str(), widen(mode).c_str()); }

inline std::string envVar(const char* name) {
  std::wstring n = widen(name);
  DWORD k = GetEnvironmentVariableW(n.c_str(), nullptr, 0);
  if (!k) return std::string();
  std::wstring w((size_t)k, L'\0');
  k = GetEnvironmentVariableW(n.c_str(), &w[0], k);
  w.resize(k);
  return narrow(w);
}
#else
constexpr char kPathListSep = ':';

inline void* dlOpen(const std::string& path, std::string& err) {
  void* h = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (!h) { const char* e = dlerror(); err = e ? e : "dlopen failed: " + path; }
  return h;
}
inline void* dlSym(void* h, const char* name) { return h ? dlsym(h, name) : nullptr; }
inline void dlClose(void* h) { if (h) dlclose(h); }

inline FILE* fopenUtf8(const std::string& path, const char* mode) { return fopen(path.c_str(), mode); }

inline std::string envVar(const char* name) {
  const char* v = getenv(name);
  return v ? std::string(v) : std::string();
}
#endif

/** Splits an environment path list ($CLAP_PATH, $DAW3_PRESET_DIRS) on ':' (POSIX) or ';' (Windows). */
inline std::vector<std::string> splitPathList(const std::string& s) {
  std::vector<std::string> out;
  size_t a = 0;
  while (a <= s.size()) {
    size_t b = s.find(kPathListSep, a);
    if (b == std::string::npos) b = s.size();
    if (b > a) out.push_back(s.substr(a, b - a));
    a = b + 1;
  }
  return out;
}

}  // namespace daw3
