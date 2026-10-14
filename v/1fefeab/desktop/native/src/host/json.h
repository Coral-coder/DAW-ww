// Minimal JSON value / parser / writer for the plugin host's line protocol (one JSON object per line).
#pragma once
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace daw3 {

class Json {
 public:
  enum Type { Null, Bool, Number, String, Array, Object };
  Json() = default;
  Json(std::nullptr_t) {}
  Json(bool b) : t_(Bool), b_(b) {}
  Json(int v) : t_(Number), n_(v) {}
  Json(unsigned v) : t_(Number), n_(v) {}
  Json(long v) : t_(Number), n_((double)v) {}
  Json(long long v) : t_(Number), n_((double)v) {}
  Json(unsigned long v) : t_(Number), n_((double)v) {}
  Json(unsigned long long v) : t_(Number), n_((double)v) {}
  Json(double v) : t_(Number), n_(v) {}
  Json(const char* s) : t_(String), s_(s) {}
  Json(std::string s) : t_(String), s_(std::move(s)) {}
  static Json array() { Json j; j.t_ = Array; return j; }
  static Json object() { Json j; j.t_ = Object; return j; }

  Type type() const { return t_; }
  bool isNull() const { return t_ == Null; }
  bool isObject() const { return t_ == Object; }
  bool isArray() const { return t_ == Array; }
  bool isString() const { return t_ == String; }
  bool isNumber() const { return t_ == Number; }

  double num(double def = 0) const { return t_ == Number ? n_ : t_ == Bool ? (b_ ? 1 : 0) : def; }
  bool boolean(bool def = false) const { return t_ == Bool ? b_ : t_ == Number ? n_ != 0 : def; }
  const std::string& str() const { static const std::string e; return t_ == String ? s_ : e; }
  std::string str(const std::string& def) const { return t_ == String ? s_ : def; }
  const std::vector<Json>& items() const { static const std::vector<Json> e; return t_ == Array ? a_ : e; }
  const std::map<std::string, Json>& fields() const { static const std::map<std::string, Json> e; return t_ == Object ? o_ : e; }

  const Json& operator[](const std::string& k) const {
    static const Json kNil;
    if (t_ != Object) return kNil;
    auto it = o_.find(k);
    return it == o_.end() ? kNil : it->second;
  }
  Json& set(const std::string& k, Json v) { if (t_ != Object) { *this = object(); } o_[k] = std::move(v); return *this; }
  Json& push(Json v) { if (t_ != Array) { *this = array(); } a_.push_back(std::move(v)); return *this; }
  bool has(const std::string& k) const { return t_ == Object && o_.count(k); }

  std::string dump() const { std::string out; write(out); return out; }

  static Json parse(const std::string& s, bool* ok = nullptr) {
    size_t i = 0;
    bool good = true;
    Json j = parseValue(s, i, good, 0);
    skip(s, i);
    if (i != s.size()) good = false;
    if (ok) *ok = good;
    return good ? j : Json();
  }

 private:
  static void skip(const std::string& s, size_t& i) { while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++; }
  static void putUtf8(std::string& o, uint32_t cp) {
    if (cp < 0x80) o += (char)cp;
    else if (cp < 0x800) { o += (char)(0xC0 | (cp >> 6)); o += (char)(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { o += (char)(0xE0 | (cp >> 12)); o += (char)(0x80 | ((cp >> 6) & 0x3F)); o += (char)(0x80 | (cp & 0x3F)); }
    else { o += (char)(0xF0 | (cp >> 18)); o += (char)(0x80 | ((cp >> 12) & 0x3F)); o += (char)(0x80 | ((cp >> 6) & 0x3F)); o += (char)(0x80 | (cp & 0x3F)); }
  }
  static bool parseString(const std::string& s, size_t& i, std::string& out) {
    if (s[i] != '"') return false;
    i++;
    while (i < s.size()) {
      char c = s[i++];
      if (c == '"') return true;
      if (c != '\\') { out += c; continue; }
      if (i >= s.size()) return false;
      char e = s[i++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          if (i + 4 > s.size()) return false;
          uint32_t cp = (uint32_t)strtoul(s.substr(i, 4).c_str(), nullptr, 16);
          i += 4;
          if (cp >= 0xD800 && cp < 0xDC00 && i + 6 <= s.size() && s[i] == '\\' && s[i + 1] == 'u') {
            uint32_t lo = (uint32_t)strtoul(s.substr(i + 2, 4).c_str(), nullptr, 16);
            if (lo >= 0xDC00 && lo < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); i += 6; }
          }
          putUtf8(out, cp);
          break;
        }
        default: return false;
      }
    }
    return false;
  }
  static Json parseValue(const std::string& s, size_t& i, bool& ok, int depth) {
    skip(s, i);
    if (i >= s.size() || depth > 64) { ok = false; return Json(); }
    char c = s[i];
    if (c == '{') {
      Json o = object();
      i++;
      skip(s, i);
      if (i < s.size() && s[i] == '}') { i++; return o; }
      while (ok) {
        skip(s, i);
        std::string k;
        if (i >= s.size() || !parseString(s, i, k)) { ok = false; break; }
        skip(s, i);
        if (i >= s.size() || s[i] != ':') { ok = false; break; }
        i++;
        o.o_[k] = parseValue(s, i, ok, depth + 1);
        skip(s, i);
        if (i < s.size() && s[i] == ',') { i++; continue; }
        if (i < s.size() && s[i] == '}') { i++; break; }
        ok = false;
      }
      return o;
    }
    if (c == '[') {
      Json a = array();
      i++;
      skip(s, i);
      if (i < s.size() && s[i] == ']') { i++; return a; }
      while (ok) {
        a.a_.push_back(parseValue(s, i, ok, depth + 1));
        skip(s, i);
        if (i < s.size() && s[i] == ',') { i++; continue; }
        if (i < s.size() && s[i] == ']') { i++; break; }
        ok = false;
      }
      return a;
    }
    if (c == '"') { std::string str; if (!parseString(s, i, str)) ok = false; return Json(str); }
    if (s.compare(i, 4, "true") == 0) { i += 4; return Json(true); }
    if (s.compare(i, 5, "false") == 0) { i += 5; return Json(false); }
    if (s.compare(i, 4, "null") == 0) { i += 4; return Json(); }
    const char* start = s.c_str() + i;
    char* end = nullptr;
    double v = strtod(start, &end);
    if (end == start) { ok = false; return Json(); }
    i += (size_t)(end - start);
    return Json(v);
  }
  static void writeString(std::string& out, const std::string& s) {
    out += '"';
    for (unsigned char c : s) {
      switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
          if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); out += b; }
          else out += (char)c;
      }
    }
    out += '"';
  }
  void write(std::string& out) const {
    switch (t_) {
      case Null: out += "null"; break;
      case Bool: out += b_ ? "true" : "false"; break;
      case Number: {
        if (!std::isfinite(n_)) { out += "null"; break; }
        char b[32];
        if (n_ == std::floor(n_) && std::fabs(n_) < 1e15) snprintf(b, sizeof b, "%.0f", n_);
        else snprintf(b, sizeof b, "%.17g", n_);
        out += b;
        break;
      }
      case String: writeString(out, s_); break;
      case Array: {
        out += '[';
        for (size_t k = 0; k < a_.size(); k++) { if (k) out += ','; a_[k].write(out); }
        out += ']';
        break;
      }
      case Object: {
        out += '{';
        bool first = true;
        for (auto& kv : o_) { if (!first) out += ','; first = false; writeString(out, kv.first); out += ':'; kv.second.write(out); }
        out += '}';
        break;
      }
    }
  }
  Type t_ = Null;
  bool b_ = false;
  double n_ = 0;
  std::string s_;
  std::vector<Json> a_;
  std::map<std::string, Json> o_;
};

inline std::string base64Encode(const std::vector<uint8_t>& in) {
  static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((in.size() + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < in.size(); i += 3) {
    uint32_t v = (in[i] << 16) | (in[i + 1] << 8) | in[i + 2];
    out += t[v >> 18]; out += t[(v >> 12) & 63]; out += t[(v >> 6) & 63]; out += t[v & 63];
  }
  if (i + 1 == in.size()) { uint32_t v = in[i] << 16; out += t[v >> 18]; out += t[(v >> 12) & 63]; out += "=="; }
  else if (i + 2 == in.size()) { uint32_t v = (in[i] << 16) | (in[i + 1] << 8); out += t[v >> 18]; out += t[(v >> 12) & 63]; out += t[(v >> 6) & 63]; out += '='; }
  return out;
}

inline std::vector<uint8_t> base64Decode(const std::string& in) {
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+' || c == '-') return 62;
    if (c == '/' || c == '_') return 63;
    return -1;
  };
  std::vector<uint8_t> out;
  uint32_t buf = 0;
  int bits = 0;
  for (char c : in) {
    int v = val(c);
    if (v < 0) continue;
    buf = (buf << 6) | (uint32_t)v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push_back((uint8_t)((buf >> bits) & 0xFF)); }
  }
  return out;
}

}  // namespace daw3
