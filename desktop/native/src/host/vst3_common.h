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

}  // namespace v3
}  // namespace daw3
