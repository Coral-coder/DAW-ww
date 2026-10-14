// Shared-memory block protocol between the app (audio server, via the addon) and the out-of-process
// plugin host. One region per host process; the app serialises process() calls, so a single slot is
// enough. Wake-ups go through two FIFOs (portable, and poll() gives the app a timeout — macOS has no
// sem_timedwait), so a hung or crashed plugin can never block the app's audio path for long.
#pragma once
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <poll.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#include <atomic>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <string>

namespace daw3 {

constexpr uint32_t kShmMagic = 0x48503344;  // "D3PH"
constexpr uint32_t kShmVersion = 2;
constexpr uint32_t kMaxMidi = 512;
constexpr uint32_t kMaxParamEvents = 256;

struct ShmMidi { uint32_t offset; uint8_t data[3]; uint8_t pad; };
struct ShmParam { uint32_t offset; uint32_t id; double value; };

enum ShmStatus : uint32_t { kShmOk = 0, kShmNoInstance = 1, kShmError = 2 };

struct ShmHeader {
  uint32_t magic, version, maxFrames, maxChannels;
  // request
  uint32_t instId, nframes, numIn, numOut;
  uint32_t numSc, reserved;  // sidechain channels follow the numIn main channels in the input area
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
/** Planar input: channel c at shmIn(h) + c * maxFrames (main channels, then sidechain channels). */
inline float* shmIn(ShmHeader* h) { return reinterpret_cast<float*>(reinterpret_cast<char*>(h) + shmAudioOffset()); }
inline float* shmOut(ShmHeader* h) { return shmIn(h) + size_t(h->maxFrames) * h->maxChannels; }

#ifdef _WIN32
/** Windows: the "path" names a pagefile-backed section ("Local\\daw3-…"), and a FIFO becomes a named auto-reset
 *  event — the same create / open / post / wait(timeout) protocol as the POSIX version below. */
inline std::wstring shmObjectName(const std::string& path, const char* kind) {
  // only the file name (unique per app process: daw3-ph-<pid>-<n>.shm): argv on Windows is in the ANSI code page,
  // so a non-ASCII temp folder would otherwise name a different object in the plugin host
  const size_t k = path.find_last_of("/\\");
  std::string n = std::string("Local\\daw3-") + kind + "-";
  for (char c : (k == std::string::npos ? path : path.substr(k + 1))) n += (c == ':' ? '_' : c);
  if (n.size() > 240) n = n.substr(n.size() - 240);
  std::wstring w;
  for (unsigned char c : n) w += (wchar_t)c;
  return w;
}

class ShmRegion {
 public:
  ~ShmRegion() { close(); }
  bool create(const std::string& path, size_t size) {
    h_ = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, (DWORD)((uint64_t)size >> 32), (DWORD)(size & 0xffffffffu), shmObjectName(path, "shm").c_str());
    if (!h_) return false;
    return map(size);
  }
  bool open(const std::string& path) {
    h_ = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, shmObjectName(path, "shm").c_str());
    if (!h_) return false;
    return map(0);
  }
  void close() {
    if (ptr_) UnmapViewOfFile(ptr_);
    ptr_ = nullptr;
    if (h_) CloseHandle(h_);
    h_ = nullptr;
  }
  void* ptr() const { return ptr_; }
  size_t size() const { return size_; }

 private:
  bool map(size_t size) {
    void* p = MapViewOfFile(h_, FILE_MAP_ALL_ACCESS, 0, 0, size);
    if (!p) { close(); return false; }
    if (!size) { MEMORY_BASIC_INFORMATION mi; size = VirtualQuery(p, &mi, sizeof mi) ? mi.RegionSize : 0; }
    ptr_ = p;
    size_ = size;
    return true;
  }
  HANDLE h_ = nullptr;
  void* ptr_ = nullptr;
  size_t size_ = 0;
};

class FifoSignal {
 public:
  ~FifoSignal() { close(); }
  bool create(const std::string& path) {
    h_ = CreateEventW(nullptr, FALSE, FALSE, shmObjectName(path, "sig").c_str());
    return h_ != nullptr;
  }
  bool open(const std::string& path) {
    h_ = OpenEventW(EVENT_MODIFY_STATE | SYNCHRONIZE, FALSE, shmObjectName(path, "sig").c_str());
    return h_ != nullptr;
  }
  void post() { if (h_) SetEvent(h_); }
  /** Waits for at least one post (timeoutMs < 0 = forever); posts coalesce like the drained FIFO. */
  bool wait(int timeoutMs) { return h_ && WaitForSingleObject(h_, timeoutMs < 0 ? INFINITE : (DWORD)timeoutMs) == WAIT_OBJECT_0; }
  void close() {
    if (h_) CloseHandle(h_);
    h_ = nullptr;
  }

 private:
  HANDLE h_ = nullptr;
};
#else
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

#endif  // _WIN32

}  // namespace daw3
