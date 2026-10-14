// Small helpers shared by the VST3 host and the VST3 test plugin, built only on the MIT-licensed
// VST3 pluginterfaces (no Steinberg SDK hosting library needed).
#pragma once
#include <atomic>
#include <cstring>
#include <string>
#include <vector>

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/base/ibstream.h"

namespace daw3 {
namespace v3 {

using namespace Steinberg;

/** queryInterface over a list of interfaces a class derives from (FUnknown answers with the first). */
template <class Self, class First, class... Rest>
struct Query {
  static tresult run(Self* s, const TUID iid, void** obj) {
    if (FUnknownPrivate::iidEqual(iid, First::iid)) { *obj = static_cast<First*>(s); s->addRef(); return kResultOk; }
    if constexpr (sizeof...(Rest) > 0) return Query<Self, Rest...>::run(s, iid, obj);
    else {
      if (FUnknownPrivate::iidEqual(iid, FUnknown::iid)) { *obj = static_cast<First*>(s); s->addRef(); return kResultOk; }
      *obj = nullptr;
      return kNoInterface;
    }
  }
};

#define D3_REFCOUNT_DELETE                                                                \
  std::atomic<uint32> refs_{1};                                                          \
  uint32 PLUGIN_API addRef() override { return ++refs_; }                                \
  uint32 PLUGIN_API release() override { uint32 r = --refs_; if (!r) delete this; return r; }

// Host-owned objects: plugins may addRef/release them freely, the owner frees them.
#define D3_REFCOUNT_STATIC                                    \
  uint32 PLUGIN_API addRef() override { return 1000; }        \
  uint32 PLUGIN_API release() override { return 1000; }

/** IBStream over a byte vector. */
class MemoryStream : public IBStream {
 public:
  explicit MemoryStream(std::vector<uint8_t> data = {}) : d_(std::move(data)) {}
  D3_REFCOUNT_DELETE
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override { return Query<MemoryStream, IBStream>::run(this, iid, obj); }
  tresult PLUGIN_API read(void* buffer, int32 n, int32* got) override {
    if (n < 0) n = 0;
    size_t k = std::min<size_t>((size_t)n, d_.size() > pos_ ? d_.size() - pos_ : 0);
    if (k) std::memcpy(buffer, d_.data() + pos_, k);
    pos_ += k;
    if (got) *got = (int32)k;
    return kResultOk;
  }
  tresult PLUGIN_API write(void* buffer, int32 n, int32* written) override {
    if (n < 0) return kInvalidArgument;
    if (pos_ + (size_t)n > d_.size()) d_.resize(pos_ + (size_t)n);
    if (n) std::memcpy(d_.data() + pos_, buffer, (size_t)n);
    pos_ += (size_t)n;
    if (written) *written = n;
    return kResultOk;
  }
  tresult PLUGIN_API seek(int64 p, int32 mode, int64* result) override {
    int64 base = mode == kIBSeekCur ? (int64)pos_ : mode == kIBSeekEnd ? (int64)d_.size() : 0;
    int64 np = base + p;
    if (np < 0) return kInvalidArgument;
    pos_ = (size_t)np;
    if (result) *result = np;
    return kResultOk;
  }
  tresult PLUGIN_API tell(int64* p) override { if (p) *p = (int64)pos_; return kResultOk; }
  const std::vector<uint8_t>& data() const { return d_; }
  void rewind() { pos_ = 0; }

 private:
  std::vector<uint8_t> d_;
  size_t pos_ = 0;
};

inline std::string utf8(const char16* s, size_t max = 128) {
  std::string out;
  for (size_t i = 0; i < max && s[i]; i++) {
    uint32_t c = (uint16_t)s[i];
    if (c >= 0xD800 && c < 0xDC00 && i + 1 < max && s[i + 1]) {
      uint32_t lo = (uint16_t)s[i + 1];
      if (lo >= 0xDC00 && lo < 0xE000) { c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00); i++; }
    }
    if (c < 0x80) out += (char)c;
    else if (c < 0x800) { out += (char)(0xC0 | (c >> 6)); out += (char)(0x80 | (c & 0x3F)); }
    else if (c < 0x10000) { out += (char)(0xE0 | (c >> 12)); out += (char)(0x80 | ((c >> 6) & 0x3F)); out += (char)(0x80 | (c & 0x3F)); }
    else { out += (char)(0xF0 | (c >> 18)); out += (char)(0x80 | ((c >> 12) & 0x3F)); out += (char)(0x80 | ((c >> 6) & 0x3F)); out += (char)(0x80 | (c & 0x3F)); }
  }
  return out;
}

inline void toString128(const std::string& s, char16* out) {
  size_t i = 0;
  for (; i < s.size() && i < 127; i++) out[i] = (char16)(unsigned char)s[i];
  out[i] = 0;
}

inline std::string hexTuid(const TUID id) {
  static const char* h = "0123456789ABCDEF";
  std::string s;
  for (int i = 0; i < 16; i++) { s += h[((uint8_t)id[i]) >> 4]; s += h[((uint8_t)id[i]) & 15]; }
  return s;
}

inline bool parseTuid(const std::string& s, TUID out) {
  if (s.size() != 32) return false;
  auto v = [](char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; };
  for (int i = 0; i < 16; i++) {
    int a = v(s[2 * i]), b = v(s[2 * i + 1]);
    if (a < 0 || b < 0) return false;
    out[i] = (char)(a * 16 + b);
  }
  return true;
}


// ---- .vstpreset files (Steinberg's preset file format, little-endian):
//   'VST3' int32 version(1) char classId[32] (ASCII hex) int64 chunkListOffset | chunks… |
//   'List' int32 count { char id[4] int64 offset int64 size }*   chunks: 'Comp' component state, 'Cont' controller state
inline void putLE(std::vector<uint8_t>& o, uint64_t v, int bytes) { for (int i = 0; i < bytes; i++) o.push_back((uint8_t)(v >> (8 * i))); }
inline uint64_t getLE(const std::vector<uint8_t>& d, size_t at, int bytes) {
  uint64_t v = 0;
  for (int i = 0; i < bytes; i++) v |= (uint64_t)d[at + i] << (8 * i);
  return v;
}

inline std::vector<uint8_t> makeVstPreset(const std::string& classIdHex, const std::vector<uint8_t>& comp, const std::vector<uint8_t>& cont) {
  std::vector<uint8_t> o = {'V', 'S', 'T', '3'};
  putLE(o, 1, 4);
  for (size_t i = 0; i < 32; i++) o.push_back(i < classIdHex.size() ? (uint8_t)classIdHex[i] : (uint8_t)'0');
  const size_t listAt = o.size();
  putLE(o, 0, 8);
  struct E { char id[4]; uint64_t off, size; };
  std::vector<E> entries;
  entries.push_back({{'C', 'o', 'm', 'p'}, o.size(), comp.size()});
  o.insert(o.end(), comp.begin(), comp.end());
  if (!cont.empty()) {
    entries.push_back({{'C', 'o', 'n', 't'}, o.size(), cont.size()});
    o.insert(o.end(), cont.begin(), cont.end());
  }
  const uint64_t list = o.size();
  for (int i = 0; i < 8; i++) o[listAt + i] = (uint8_t)(list >> (8 * i));
  o.insert(o.end(), {'L', 'i', 's', 't'});
  putLE(o, entries.size(), 4);
  for (auto& e : entries) { o.insert(o.end(), e.id, e.id + 4); putLE(o, e.off, 8); putLE(o, e.size, 8); }
  return o;
}

/** Parse a .vstpreset: class id (hex) + component / controller state chunks. */
inline bool parseVstPreset(const std::vector<uint8_t>& d, std::string& classId, std::vector<uint8_t>& comp, std::vector<uint8_t>& cont) {
  if (d.size() < 48 || std::memcmp(d.data(), "VST3", 4) != 0) return false;
  classId.assign((const char*)d.data() + 8, 32);
  const uint64_t list = getLE(d, 40, 8);
  if (list + 8 > d.size() || std::memcmp(d.data() + list, "List", 4) != 0) return false;
  const uint64_t n = getLE(d, list + 4, 4);
  comp.clear();
  cont.clear();
  for (uint64_t i = 0; i < n && i < 64; i++) {
    const size_t at = (size_t)(list + 8 + i * 20);
    if (at + 20 > d.size()) return false;
    const uint64_t off = getLE(d, at + 4, 8), size = getLE(d, at + 12, 8);
    if (off > d.size() || size > d.size() - off) return false;
    std::vector<uint8_t>* dst = !std::memcmp(d.data() + at, "Comp", 4) ? &comp : !std::memcmp(d.data() + at, "Cont", 4) ? &cont : nullptr;
    if (dst) dst->assign(d.begin() + (long)off, d.begin() + (long)(off + size));
  }
  return true;
}

}  // namespace v3
}  // namespace daw3
