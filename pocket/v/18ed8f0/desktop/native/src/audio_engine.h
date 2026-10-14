// Native duplex audio I/O (miniaudio: CoreAudio on macOS, any backend elsewhere; the null backend
// drives unit tests). The renderer's Web Audio output arrives in `out` (stereo or N channels,
// interleaved) and is played on the chosen device channels; device inputs land in `in` for the
// app to read. All realtime work happens in process(), which unit tests call directly.
#pragma once
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "ring.h"

namespace daw3 {

struct DeviceInfo {
  std::string id;    // hex of the backend device id (stable for a device on one machine)
  std::string name;
  bool isInput = false;
  bool isDefault = false;
  unsigned maxChannels = 0;
  std::vector<unsigned> sampleRates;
};

struct EngineConfig {
  std::string outputId;        // "" = system default
  std::string inputId;         // "" = system default
  bool inputEnabled = true;
  unsigned sampleRate = 48000;
  unsigned bufferFrames = 256;  // device period (32..1024)
  unsigned deviceOutChannels = 2;
  unsigned deviceInChannels = 2;
  unsigned streamChannels = 2;  // channels the app writes per frame
  unsigned outOffset = 0;       // first device channel the stream lands on
  unsigned targetFrames = 0;    // ring fill the output aims for (0 = auto: bufferFrames + 10 ms)
};

struct EngineStats {
  bool running = false;
  unsigned sampleRate = 0, bufferFrames = 0, deviceOutChannels = 0, deviceInChannels = 0, streamChannels = 0, targetFrames = 0;
  uint64_t callbacks = 0, underruns = 0, overruns = 0, droppedFrames = 0, stretchedFrames = 0;
  uint64_t framesPlayed = 0, framesCaptured = 0;
  size_t outFill = 0, inFill = 0;
  std::string backend, outputName, inputName;
};

class AudioEngine {
 public:
  explicit AudioEngine(bool nullBackend = false);
  ~AudioEngine();
  AudioEngine(const AudioEngine&) = delete;
  AudioEngine& operator=(const AudioEngine&) = delete;

  bool listDevices(std::vector<DeviceInfo>& out, std::string& err);
  /** Opens + starts the device(s). Replaces a running stream. */
  bool open(const EngineConfig& cfg, std::string& err);
  void close();
  bool isOpen() const { return running_.load(); }

  /** Prepare rings and counters without a device (unit tests drive process() themselves). */
  void prepare(const EngineConfig& cfg);

  size_t writeOutput(const float* interleaved, size_t frames) { return out_.write(interleaved, frames); }
  size_t readInput(float* interleaved, size_t maxFrames) { return in_.read(interleaved, maxFrames); }
  size_t outputSpace() const { return out_.space(); }
  size_t inputAvailable() const { return in_.available(); }
  unsigned inputChannels() const { return in_.channels(); }
  EngineStats stats() const;

  /** Round-trip calibration: play `sig` on device channel outCh and record captureFrames from inCh. */
  bool startPing(const float* sig, size_t n, unsigned outCh, unsigned inCh, size_t captureFrames);
  bool pingDone() const { return pingState_.load() == 3; }
  std::vector<float> takePing();

  /** The realtime callback body: out = deviceOutChannels interleaved, in = deviceInChannels (may be null). */
  void process(float* out, const float* in, uint32_t frames);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  EngineConfig cfg_;
  FrameRing out_, in_;
  std::vector<float> scratch_;
  std::atomic<bool> running_{false};
  bool priming_ = true;
  std::atomic<uint64_t> callbacks_{0}, underruns_{0}, overruns_{0}, dropped_{0}, stretched_{0}, played_{0}, captured_{0};
  // ping
  std::vector<float> pingSig_, pingCap_;
  size_t pingPos_ = 0, capPos_ = 0;
  unsigned pingOut_ = 0, pingIn_ = 0;
  std::atomic<int> pingState_{0};  // 0 idle, 1 armed, 2 running, 3 done
  std::string outName_, inName_;
};

}  // namespace daw3
