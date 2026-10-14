// Lock-free single-producer / single-consumer ring of interleaved float frames.
// The audio callback is one side, the JS thread the other; neither ever blocks or allocates.
#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace daw3 {

class FrameRing {
 public:
  FrameRing() = default;
  /** capacityFrames is rounded up to a power of two. Not thread-safe: call before streaming. */
  void reset(size_t capacityFrames, unsigned channels) {
    size_t cap = 1;
    while (cap < capacityFrames) cap <<= 1;
    cap_ = cap;
    ch_ = channels ? channels : 1;
    buf_.assign(cap_ * ch_, 0.0f);
    w_.store(0, std::memory_order_relaxed);
    r_.store(0, std::memory_order_relaxed);
  }
  size_t capacity() const { return cap_; }
  unsigned channels() const { return ch_; }
  /** Frames ready to read (consumer side; also a fine estimate from the producer). */
  size_t available() const { return (size_t)(w_.load(std::memory_order_acquire) - r_.load(std::memory_order_acquire)); }
  size_t space() const { return cap_ - available(); }

  /** Producer: copy up to n frames in; returns frames written (excess is dropped). */
  size_t write(const float* src, size_t n) {
    if (!cap_) return 0;
    const uint64_t w = w_.load(std::memory_order_relaxed);
    const uint64_t r = r_.load(std::memory_order_acquire);
    const size_t free = cap_ - (size_t)(w - r);
    if (n > free) n = free;
    const size_t start = (size_t)(w & (cap_ - 1));
    const size_t first = n < cap_ - start ? n : cap_ - start;
    if (src) {
      std::memcpy(&buf_[start * ch_], src, first * ch_ * sizeof(float));
      if (n > first) std::memcpy(&buf_[0], src + first * ch_, (n - first) * ch_ * sizeof(float));
    } else {
      std::memset(&buf_[start * ch_], 0, first * ch_ * sizeof(float));
      if (n > first) std::memset(&buf_[0], 0, (n - first) * ch_ * sizeof(float));
    }
    w_.store(w + n, std::memory_order_release);
    return n;
  }

  /** Consumer: copy up to n frames out (dst may be null to skip); returns frames read. */
  size_t read(float* dst, size_t n) {
    if (!cap_) return 0;
    const uint64_t r = r_.load(std::memory_order_relaxed);
    const uint64_t w = w_.load(std::memory_order_acquire);
    const size_t avail = (size_t)(w - r);
    if (n > avail) n = avail;
    if (dst) {
      const size_t start = (size_t)(r & (cap_ - 1));
      const size_t first = n < cap_ - start ? n : cap_ - start;
      std::memcpy(dst, &buf_[start * ch_], first * ch_ * sizeof(float));
      if (n > first) std::memcpy(dst + first * ch_, &buf_[0], (n - first) * ch_ * sizeof(float));
    }
    r_.store(r + n, std::memory_order_release);
    return n;
  }

  /** Consumer: peek the last frame read again (used to stretch by one frame for drift correction). */
  void lastFrame(float* dst) const {
    const uint64_t r = r_.load(std::memory_order_relaxed);
    const size_t idx = (size_t)((r - 1) & (cap_ - 1));
    std::memcpy(dst, &buf_[idx * ch_], ch_ * sizeof(float));
  }

  uint64_t totalWritten() const { return w_.load(std::memory_order_acquire); }
  uint64_t totalRead() const { return r_.load(std::memory_order_acquire); }

 private:
  std::vector<float> buf_;
  size_t cap_ = 0;
  unsigned ch_ = 1;
  alignas(64) std::atomic<uint64_t> w_{0};
  alignas(64) std::atomic<uint64_t> r_{0};
};

}  // namespace daw3
