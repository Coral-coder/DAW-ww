#include "plugin.h"

#include <dirent.h>
#include <pwd.h>
#include <sys/stat.h>
#include <unistd.h>

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

std::string baseName(const std::string& p) {
  std::string s = p;
  while (s.size() > 1 && s.back() == '/') s.pop_back();
  size_t k = s.find_last_of('/');
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
  if (const char* env = getenv("DAW3_PRESET_DIRS")) {
    std::string s = env;
    size_t a = 0;
    while (a <= s.size()) {
      size_t b = s.find(':', a);
      if (b == std::string::npos) b = s.size();
      if (b > a) roots.push_back(s.substr(a, b - a));
      a = b + 1;
    }
  }
#ifdef __APPLE__
  roots.push_back(homeDir() + "/Library/Audio/Presets");
  roots.push_back("/Library/Audio/Presets");
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
  FILE* f = fopen(path.c_str(), "rb");
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
  for (size_t k = 1; (k = path.find('/', k)) != std::string::npos; k++) mkdir(path.substr(0, k).c_str(), 0755);
  FILE* f = fopen(path.c_str(), "wb");
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
