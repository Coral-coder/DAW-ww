// Shared-memory block protocol between the app (audio server, via the addon) and the out-of-process
// plugin host. One region per host process; the app serialises process() calls, so a single slot is
// enough. Wake-ups go through two FIFOs (portable, and poll() gives the app a timeout — macOS has no
// sem_timedwait), so a hung or crashed plugin can never block the app's audio path for long.
#pragma once
#include <fcntl.h>
#include <poll.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <string>

namespace daw3 {

constexpr uint32_t kShmMagic = 0x48503344;  // "D3PH"
constexpr uint32_t kShmVersion = 1;
constexpr uint32_t kMaxMidi = 512;
constexpr uint32_t kMaxParamEvents = 256;

struct ShmMidi { uint32_t offset; uint8_t data[3]; uint8_t pad; };
struct ShmParam { uint32_t offset; uint32_t id; double value; };

enum ShmStatus : uint32_t { kShmOk = 0, kShmNoInstance = 1, kShmError = 2 };

struct ShmHeader {
  uint32_t magic, version, maxFrames, maxChannels;
  // request
  uint32_t instId, nframes, numIn, numOut;
  uint32_t midiCount, paramCount;
  uint32_t playing, flags;
  double tempo, ppqPos, sampleRate;
  ShmMidi midi[kMaxMidi];
  ShmParam params[kMaxParamEvents];
  // response
  uint32_t status, outParamCount;
  ShmParam outParams[kMaxParamEvents];
  std::atomic<uint64_t> reqSeq, doneSeq;
};

inline size_t shmAudioOffset() { return (sizeof(ShmHeader) + 63) & ~size_t(63); }
inline size_t shmSize(uint32_t maxFrames, uint32_t maxCh) { return shmAudioOffset() + size_t(2) * maxFrames * maxCh * sizeof(float); }
/** Planar input: channel c at shmIn(h) + c * maxFrames. */
inline float* shmIn(ShmHeader* h) { return reinterpret_cast<float*>(reinterpret_cast<char*>(h) + shmAudioOffset()); }
inline float* shmOut(ShmHeader* h) { return shmIn(h) + size_t(h->maxFrames) * h->maxChannels; }

/** A file-backed shared mapping (a file in the temp dir: works the same on macOS and Linux). */
class ShmRegion {
 public:
  ~ShmRegion() { close(); }
  bool create(const std::string& path, size_t size) {
    fd_ = ::open(path.c_str(), O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (fd_ < 0) return false;
    if (ftruncate(fd_, (off_t)size) != 0) { close(); return false; }
    owner_ = true;
    path_ = path;
    return map(size);
  }
  bool open(const std::string& path) {
    fd_ = ::open(path.c_str(), O_RDWR);
    if (fd_ < 0) return false;
    struct stat st;
    if (fstat(fd_, &st) != 0) { close(); return false; }
    path_ = path;
    return map((size_t)st.st_size);
  }
  void close() {
    if (ptr_) munmap(ptr_, size_);
    ptr_ = nullptr;
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
    if (owner_ && !path_.empty()) unlink(path_.c_str());
    owner_ = false;
  }
  void* ptr() const { return ptr_; }
  size_t size() const { return size_; }

 private:
  bool map(size_t size) {
    void* p = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd_, 0);
    if (p == MAP_FAILED) { close(); return false; }
    ptr_ = p;
    size_ = size;
    return true;
  }
  int fd_ = -1;
  void* ptr_ = nullptr;
  size_t size_ = 0;
  bool owner_ = false;
  std::string path_;
};

/** One-directional wake-up signal over a named FIFO (opened O_RDWR so neither side blocks on open). */
class FifoSignal {
 public:
  ~FifoSignal() { close(); }
  bool create(const std::string& path) {
    unlink(path.c_str());
    if (mkfifo(path.c_str(), 0600) != 0) return false;
    owner_ = true;
    path_ = path;
    return open(path);
  }
  bool open(const std::string& path) {
    fd_ = ::open(path.c_str(), O_RDWR | O_NONBLOCK);
    if (fd_ < 0) return false;
    if (path_.empty()) path_ = path;
    return true;
  }
  void post() {
    const char b = 1;
    for (;;) {
      ssize_t n = ::write(fd_, &b, 1);
      if (n == 1 || (n < 0 && errno != EINTR)) return;
    }
  }
  /** Waits for at least one post (timeoutMs < 0 = forever). Drains pending posts. */
  bool wait(int timeoutMs) {
    struct pollfd p = {fd_, POLLIN, 0};
    for (;;) {
      int r = poll(&p, 1, timeoutMs);
      if (r < 0 && errno == EINTR) continue;
      if (r <= 0) return false;
      char buf[64];
      while (::read(fd_, buf, sizeof buf) > 0) {}
      return true;
    }
  }
  void close() {
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
    if (owner_ && !path_.empty()) unlink(path_.c_str());
    owner_ = false;
  }

 private:
  int fd_ = -1;
  bool owner_ = false;
  std::string path_;
};

}  // namespace daw3
