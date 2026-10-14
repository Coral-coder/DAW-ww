#include "plugin.h"

#include <dirent.h>
#include <pwd.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cstdlib>

namespace daw3 {

Json PluginDesc::toJson() const {
  Json j = Json::object();
  j.set("key", key()).set("format", format).set("uid", uid).set("name", name).set("vendor", vendor).set("version", version)
      .set("category", category).set("path", path).set("instrument", instrument).set("numInputs", numInputs)
      .set("numOutputs", numOutputs).set("midiInput", midiInput);
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
