#include "plugin.h"

#include "platform.h"

#ifdef _WIN32
#include <shlobj.h>
#else
#include <dirent.h>
#include <pwd.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#include <algorithm>
#include <cstdio>
#include <cstdlib>

namespace daw3 {

Json PluginDesc::toJson() const {
  Json j = Json::object();
  j.set("key", key()).set("format", format).set("uid", uid).set("name", name).set("vendor", vendor).set("version", version)
      .set("category", category).set("path", path).set("instrument", instrument).set("numInputs", numInputs)
      .set("numOutputs", numOutputs).set("midiInput", midiInput).set("sidechain", sidechainChannels);
  Json buses = Json::array();
  if (outputBuses.empty()) buses.push(Json::object().set("name", "Main").set("channels", numOutputs));
  for (auto& b : outputBuses) buses.push(Json::object().set("name", b.name).set("channels", b.channels));
  j.set("outputBuses", buses).set("totalOutputs", totalOutputs());
  return j;
}

Json PresetInfo::toJson() const {
  Json j = Json::object();
  j.set("id", id).set("name", name).set("category", category).set("kind", kind);
  if (!path.empty()) j.set("path", path);
  return j;
}

Json ParamInfo::toJson() const {
  Json j = Json::object();
  j.set("id", id).set("name", name).set("module", module).set("unit", unit).set("min", min).set("max", max).set("default", def)
      .set("steps", steps).set("flags", flags);
  return j;
}

#ifdef _WIN32
std::string homeDir() {
  std::string h = envVar("DAW3_HOME");  // tests / the app's fake home
  if (!h.empty()) return h;
  h = envVar("USERPROFILE");
  if (!h.empty()) return h;
  return envVar("HOMEDRIVE") + envVar("HOMEPATH");
}

/** A known folder (FOLDERID_ProgramFilesCommon, FOLDERID_LocalAppData, FOLDERID_Documents …) as UTF-8. */
static std::string knownFolder(const KNOWNFOLDERID& id) {
  PWSTR w = nullptr;
  std::string s;
  if (SHGetKnownFolderPath(id, 0, nullptr, &w) == S_OK && w) s = narrow(w);
  if (w) CoTaskMemFree(w);
  return s;
}

std::string winFolder(WinFolder f) {
  switch (f) {
    case WinFolder::CommonProgramFiles: { std::string s = knownFolder(FOLDERID_ProgramFilesCommon); return s.empty() ? envVar("CommonProgramFiles") : s; }
    case WinFolder::LocalAppData: { std::string s = knownFolder(FOLDERID_LocalAppData); return s.empty() ? envVar("LOCALAPPDATA") : s; }
    case WinFolder::Documents: { if (!envVar("DAW3_HOME").empty()) return homeDir() + "/Documents";
      std::string s = knownFolder(FOLDERID_Documents); return s.empty() ? homeDir() + "/Documents" : s; }
  }
  return "";
}

static DWORD attrs(const std::string& p) { return GetFileAttributesW(winPath(p).c_str()); }

bool isDirectory(const std::string& p) {
  const DWORD a = attrs(p);
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

static bool exists(const std::string& p) { return attrs(p) != INVALID_FILE_ATTRIBUTES; }

std::vector<std::string> listDir(const std::string& p) {
  std::vector<std::string> out;
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW((winPath(p) + L"\\*").c_str(), &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      std::string n = narrow(fd.cFileName);
      if (n == "." || n == "..") continue;
      out.push_back(n);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
  }
  std::sort(out.begin(), out.end());
  return out;
}

static void makeDir(const std::string& p) { CreateDirectoryW(winPath(p).c_str(), nullptr); }
#else
std::string homeDir() {
  if (const char* h = getenv("HOME")) return h;
  if (struct passwd* pw = getpwuid(getuid())) return pw->pw_dir;
  return "";
}

bool isDirectory(const std::string& p) {
  struct stat st;
  return stat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
}

static bool exists(const std::string& p) {
  struct stat st;
  return stat(p.c_str(), &st) == 0;
}

std::vector<std::string> listDir(const std::string& p) {
  std::vector<std::string> out;
  if (DIR* d = opendir(p.c_str())) {
    while (struct dirent* e = readdir(d)) {
      std::string n = e->d_name;
      if (n == "." || n == "..") continue;
      out.push_back(n);
    }
    closedir(d);
  }
  std::sort(out.begin(), out.end());
  return out;
}

static void makeDir(const std::string& p) { mkdir(p.c_str(), 0755); }
#endif

std::string baseName(const std::string& p) {
  std::string s = p;
  while (s.size() > 1 && (s.back() == '/' || s.back() == '\\')) s.pop_back();
  size_t k = s.find_last_of("/\\");
  return k == std::string::npos ? s : s.substr(k + 1);
}

std::string stripExt(const std::string& s) {
  size_t k = s.find_last_of('.');
  return k == std::string::npos ? s : s.substr(0, k);
}

static bool endsWithI(const std::string& s, const std::string& suf) {
  if (s.size() < suf.size()) return false;
  for (size_t i = 0; i < suf.size(); i++)
    if (tolower((unsigned char)s[s.size() - suf.size() + i]) != tolower((unsigned char)suf[i])) return false;
  return true;
}

static void findRec(const std::string& dir, const std::string& ext, int depth, std::vector<std::string>& out) {
  if (depth > 5 || out.size() > 5000) return;
  for (auto& n : listDir(dir)) {
    if (n[0] == '.') continue;
    std::string p = dir + "/" + n;
    if (endsWithI(n, ext)) out.push_back(p);
    else if (isDirectory(p)) findRec(p, ext, depth + 1, out);
  }
}

std::vector<std::string> PluginFormat::findBundles(const std::vector<std::string>& dirs) const {
  std::vector<std::string> out;
  for (auto& d : dirs) {
    if (endsWithI(d, bundleExtension()) && exists(d)) out.push_back(d);
    else if (isDirectory(d)) findRec(d, bundleExtension(), 0, out);
  }
  std::sort(out.begin(), out.end());
  out.erase(std::unique(out.begin(), out.end()), out.end());
  return out;
}

static std::string safeSegment(std::string s) {
  for (auto& c : s) if (c == '/' || c == ':' || c == '\\') c = '_';
  return s;
}

std::vector<std::string> presetFolders(const PluginDesc& d) {
  std::vector<std::string> roots;
  for (auto& r : splitPathList(envVar("DAW3_PRESET_DIRS"))) roots.push_back(r);
#ifdef __APPLE__
  roots.push_back(homeDir() + "/Library/Audio/Presets");
  roots.push_back("/Library/Audio/Presets");
#elif defined(_WIN32)
  roots.push_back(winFolder(WinFolder::Documents) + "/VST3 Presets");  // Steinberg's per-user preset location
#else
  roots.push_back(homeDir() + "/.vst3/presets");
#endif
  std::vector<std::string> out;
  for (auto& r : roots) {
    out.push_back(r + "/" + safeSegment(d.vendor) + "/" + safeSegment(d.name));
    // AU presets also live under the plugin name alone (Logic's habit)
    if (d.format == "au") out.push_back(r + "/" + safeSegment(d.name));
  }
  return out;
}

static void findFilesRec(const std::string& dir, const std::string& rel, const std::string& ext, int depth, std::vector<std::pair<std::string, std::string>>& out) {
  if (depth > 4 || out.size() > 2000) return;
  for (auto& n : listDir(dir)) {
    if (n[0] == '.') continue;
    std::string p = dir + "/" + n;
    if (endsWithI(n, ext)) out.emplace_back(p, rel);
    else if (isDirectory(p)) findFilesRec(p, rel.empty() ? n : rel + "/" + n, ext, depth + 1, out);
  }
}

std::vector<std::pair<std::string, std::string>> findPresetFiles(const std::vector<std::string>& dirs, const std::string& ext) {
  std::vector<std::pair<std::string, std::string>> out;
  for (auto& d : dirs) if (isDirectory(d)) findFilesRec(d, "", ext, 0, out);
  std::sort(out.begin(), out.end());
  out.erase(std::unique(out.begin(), out.end()), out.end());
  return out;
}

bool readFile(const std::string& path, std::vector<uint8_t>& out) {
  FILE* f = fopenUtf8(path, "rb");
  if (!f) return false;
  out.clear();
  uint8_t buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) {
    out.insert(out.end(), buf, buf + n);
    if (out.size() > (size_t)64 * 1024 * 1024) { fclose(f); return false; }
  }
  fclose(f);
  return true;
}

bool writeFile(const std::string& path, const std::vector<uint8_t>& data) {
  // create missing parent folders
  for (size_t k = 1; (k = path.find_first_of("/\\", k)) != std::string::npos; k++) makeDir(path.substr(0, k));
  FILE* f = fopenUtf8(path, "wb");
  if (!f) return false;
  const bool ok = fwrite(data.data(), 1, data.size(), f) == data.size();
  return fclose(f) == 0 && ok;
}

std::string bundleBinary(const std::string& bundle, const std::string& ext) {
  if (!isDirectory(bundle)) return bundle;
  const std::string stem = stripExt(baseName(bundle));
#ifdef __APPLE__
  std::string mac = bundle + "/Contents/MacOS/" + stem;
  if (exists(mac)) return mac;
  for (auto& n : listDir(bundle + "/Contents/MacOS")) return bundle + "/Contents/MacOS/" + n;
#elif defined(_WIN32)
  // VST3 bundle on Windows: Contents/<arch>-win/<name>.vst3 (a DLL); a plain .vst3 / .clap file is the binary itself
#if defined(_M_ARM64) || defined(__aarch64__)
  const char* archs[] = {"arm64-win", "arm64x-win", "arm64ec-win"};
#else
  const char* archs[] = {"x86_64-win"};
#endif
  for (const char* arch : archs) {
    std::string dll = bundle + "/Contents/" + arch + "/" + stem + ".vst3";
    if (exists(dll)) return dll;
  }
#else
#if defined(__aarch64__)
  const char* arch = "aarch64-linux";
#else
  const char* arch = "x86_64-linux";
#endif
  std::string so = bundle + "/Contents/" + arch + "/" + stem + ".so";
  if (exists(so)) return so;
#endif
  (void)ext;
  return "";
}

}  // namespace daw3
