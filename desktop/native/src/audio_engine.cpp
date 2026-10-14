#include "audio_engine.h"

#include <algorithm>
#include <cstring>

#include "miniaudio_config.h"
#include "miniaudio.h"

namespace daw3 {

static std::string hexId(const ma_device_id& id) {
  const unsigned char* p = reinterpret_cast<const unsigned char*>(&id);
  size_t n = sizeof(ma_device_id);
  while (n > 0 && p[n - 1] == 0) n--;
  static const char* hex = "0123456789abcdef";
  std::string s;
  s.reserve(n * 2 + 1);
  for (size_t i = 0; i < n; i++) { s += hex[p[i] >> 4]; s += hex[p[i] & 15]; }
  return s.empty() ? "00" : s;
}

static bool parseHexId(const std::string& s, ma_device_id& out) {
  std::memset(&out, 0, sizeof out);
  if (s.size() % 2 || s.size() / 2 > sizeof(ma_device_id)) return false;
  unsigned char* p = reinterpret_cast<unsigned char*>(&out);
  auto v = [](char c) -> int { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; };
  for (size_t i = 0; i < s.size() / 2; i++) {
    int a = v(s[2 * i]), b = v(s[2 * i + 1]);
    if (a < 0 || b < 0) return false;
    p[i] = (unsigned char)(a * 16 + b);
  }
  return true;
}

struct AudioEngine::Impl {
  ma_context ctx{};
  bool ctxOk = false;
  ma_device dev{};
  bool devOk = false;
  bool nullBackend = false;
};

static void dataCallback(ma_device* d, void* out, const void* in, ma_uint32 frames) {
  static_cast<AudioEngine*>(d->pUserData)->process(static_cast<float*>(out), static_cast<const float*>(in), frames);
}

AudioEngine::AudioEngine(bool nullBackend) : impl_(new Impl) {
  impl_->nullBackend = nullBackend;
  ma_context_config cc = ma_context_config_init();
  if (nullBackend) {
    ma_backend b[] = {ma_backend_null};
    impl_->ctxOk = ma_context_init(b, 1, &cc, &impl_->ctx) == MA_SUCCESS;
  } else {
    impl_->ctxOk = ma_context_init(nullptr, 0, &cc, &impl_->ctx) == MA_SUCCESS;
  }
}

AudioEngine::~AudioEngine() {
  close();
  if (impl_->ctxOk) ma_context_uninit(&impl_->ctx);
}

bool AudioEngine::listDevices(std::vector<DeviceInfo>& out, std::string& err) {
  out.clear();
  if (!impl_->ctxOk) { err = "No audio backend available"; return false; }
  ma_device_info *pb = nullptr, *cap = nullptr;
  ma_uint32 nPb = 0, nCap = 0;
  if (ma_context_get_devices(&impl_->ctx, &pb, &nPb, &cap, &nCap) != MA_SUCCESS) { err = "Device enumeration failed"; return false; }
  // copy first: ma_context_get_device_info may reuse the enumeration buffers
  std::vector<ma_device_info> pbs(pb, pb + nPb), caps(cap, cap + nCap);
  auto add = [&](const ma_device_info& base, bool input) {
    DeviceInfo d;
    d.id = hexId(base.id);
    d.name = base.name;
    d.isInput = input;
    d.isDefault = base.isDefault != 0;
    ma_device_info full;
    if (ma_context_get_device_info(&impl_->ctx, input ? ma_device_type_capture : ma_device_type_playback, &base.id, &full) == MA_SUCCESS) {
      d.isDefault = d.isDefault || full.isDefault;
      for (ma_uint32 i = 0; i < full.nativeDataFormatCount; i++) {
        const auto& f = full.nativeDataFormats[i];
        d.maxChannels = std::max<unsigned>(d.maxChannels, f.channels ? f.channels : 2);
        if (f.sampleRate && std::find(d.sampleRates.begin(), d.sampleRates.end(), f.sampleRate) == d.sampleRates.end()) d.sampleRates.push_back(f.sampleRate);
      }
    }
    if (!d.maxChannels) d.maxChannels = 2;
    if (d.sampleRates.empty()) d.sampleRates = {44100, 48000, 88200, 96000};
    std::sort(d.sampleRates.begin(), d.sampleRates.end());
    out.push_back(d);
  };
  for (auto& d : pbs) add(d, false);
  for (auto& d : caps) add(d, true);
  return true;
}

void AudioEngine::prepare(const EngineConfig& c) {
  cfg_ = c;
  cfg_.bufferFrames = std::clamp(cfg_.bufferFrames, 16u, 4096u);
  if (!cfg_.streamChannels) cfg_.streamChannels = 2;
  if (!cfg_.deviceOutChannels) cfg_.deviceOutChannels = cfg_.streamChannels;
  if (cfg_.outOffset + cfg_.streamChannels > cfg_.deviceOutChannels) cfg_.outOffset = cfg_.deviceOutChannels > cfg_.streamChannels ? cfg_.deviceOutChannels - cfg_.streamChannels : 0;
  if (!cfg_.targetFrames) cfg_.targetFrames = cfg_.bufferFrames + cfg_.sampleRate / 100;
  const size_t ringFrames = std::max<size_t>(8192, (size_t)cfg_.targetFrames * 4 + cfg_.bufferFrames * 4);
  out_.reset(ringFrames, cfg_.streamChannels);
  in_.reset(std::max<size_t>(ringFrames, cfg_.sampleRate / 2), cfg_.inputEnabled ? std::max(1u, cfg_.deviceInChannels) : 1);
  scratch_.assign((size_t)8192 * cfg_.streamChannels, 0.f);
  priming_ = true;
  for (auto* a : {&callbacks_, &underruns_, &overruns_, &dropped_, &stretched_, &played_, &captured_}) a->store(0);
  pingState_.store(0);
}

bool AudioEngine::open(const EngineConfig& c, std::string& err) {
  close();
  if (!impl_->ctxOk) { err = "No audio backend available"; return false; }
  const bool duplex = c.inputEnabled;
  ma_device_config dc = ma_device_config_init(duplex ? ma_device_type_duplex : ma_device_type_playback);
  ma_device_id outId, inId;
  const bool hasOut = !c.outputId.empty() && parseHexId(c.outputId, outId);
  const bool hasIn = !c.inputId.empty() && parseHexId(c.inputId, inId);
  if (!c.outputId.empty() && !hasOut) { err = "Bad output device id"; return false; }
  if (duplex && !c.inputId.empty() && !hasIn) { err = "Bad input device id"; return false; }
  dc.playback.pDeviceID = hasOut ? &outId : nullptr;
  dc.playback.format = ma_format_f32;
  dc.playback.channels = std::max(1u, c.deviceOutChannels);
  dc.capture.pDeviceID = hasIn ? &inId : nullptr;
  dc.capture.format = ma_format_f32;
  dc.capture.channels = std::max(1u, c.deviceInChannels);
  dc.sampleRate = c.sampleRate;
  dc.periodSizeInFrames = std::clamp(c.bufferFrames, 16u, 4096u);
  dc.periods = 2;
  dc.performanceProfile = ma_performance_profile_low_latency;
  dc.noPreSilencedOutputBuffer = MA_FALSE;
  dc.noClip = MA_TRUE;
  dc.dataCallback = dataCallback;
  dc.pUserData = this;
  dc.coreaudio.allowNominalSampleRateChange = MA_TRUE;
  if (ma_device_init(&impl_->ctx, &dc, &impl_->dev) != MA_SUCCESS) { err = "Could not open the audio device (check the sample rate / channel count)"; return false; }
  impl_->devOk = true;
  EngineConfig actual = c;
  actual.sampleRate = impl_->dev.sampleRate;
  actual.deviceOutChannels = impl_->dev.playback.channels;
  actual.deviceInChannels = duplex ? impl_->dev.capture.channels : 0;
  if (impl_->dev.playback.internalPeriodSizeInFrames) actual.bufferFrames = impl_->dev.playback.internalPeriodSizeInFrames;
  prepare(actual);
  outName_ = impl_->dev.playback.name;
  inName_ = duplex ? impl_->dev.capture.name : "";
  running_.store(true);
  if (ma_device_start(&impl_->dev) != MA_SUCCESS) { err = "Could not start the audio device"; close(); return false; }
  return true;
}

void AudioEngine::close() {
  if (impl_->devOk) { ma_device_uninit(&impl_->dev); impl_->devOk = false; }
  running_.store(false);
}

EngineStats AudioEngine::stats() const {
  EngineStats s;
  s.running = running_.load();
  s.sampleRate = cfg_.sampleRate;
  s.bufferFrames = cfg_.bufferFrames;
  s.deviceOutChannels = cfg_.deviceOutChannels;
  s.deviceInChannels = cfg_.inputEnabled ? cfg_.deviceInChannels : 0;
  s.streamChannels = cfg_.streamChannels;
  s.targetFrames = cfg_.targetFrames;
  s.callbacks = callbacks_.load();
  s.underruns = underruns_.load();
  s.overruns = overruns_.load();
  s.droppedFrames = dropped_.load();
  s.stretchedFrames = stretched_.load();
  s.framesPlayed = played_.load();
  s.framesCaptured = captured_.load();
  s.outFill = out_.available();
  s.inFill = in_.available();
  s.backend = impl_->ctxOk ? ma_get_backend_name(impl_->ctx.backend) : "none";
  s.outputName = outName_;
  s.inputName = inName_;
  return s;
}

bool AudioEngine::startPing(const float* sig, size_t n, unsigned outCh, unsigned inCh, size_t captureFrames) {
  if (pingState_.load() == 1 || pingState_.load() == 2) return false;
  pingSig_.assign(sig, sig + n);
  pingCap_.assign(captureFrames, 0.f);
  pingPos_ = capPos_ = 0;
  pingOut_ = outCh;
  pingIn_ = inCh;
  pingState_.store(1);
  return true;
}

std::vector<float> AudioEngine::takePing() {
  if (pingState_.load() != 3) return {};
  pingState_.store(0);
  return std::move(pingCap_);
}

void AudioEngine::process(float* out, const float* in, uint32_t frames) {
  callbacks_.fetch_add(1, std::memory_order_relaxed);
  const unsigned dch = cfg_.deviceOutChannels, sch = cfg_.streamChannels;
  // ---- input -> ring
  if (in && cfg_.inputEnabled) {
    const size_t w = in_.write(in, frames);
    if (w < frames) overruns_.fetch_add(1, std::memory_order_relaxed);
    captured_.fetch_add(frames, std::memory_order_relaxed);
  }
  // ---- ring -> output (with drift correction around targetFrames)
  if (!out) return;
  std::memset(out, 0, sizeof(float) * frames * dch);
  size_t got = 0;
  const size_t avail = out_.available();
  const size_t target = cfg_.targetFrames;
  if (priming_) {
    if (avail >= target) priming_ = false;
  }
  if (!priming_ && frames <= scratch_.size() / sch) {
    float* tmp = scratch_.data();
    if (avail < frames) {
      underruns_.fetch_add(1, std::memory_order_relaxed);
      got = out_.read(tmp, avail);
      priming_ = true;  // refill to the target before playing again
    } else if (avail > target + std::max<size_t>(frames, target / 2)) {
      out_.read(nullptr, 1);  // producer runs fast: drop one frame
      dropped_.fetch_add(1, std::memory_order_relaxed);
      got = out_.read(tmp, frames);
    } else if (avail < target / 2 + frames && frames > 1) {
      got = out_.read(tmp, frames - 1);  // producer runs slow: repeat one frame
      std::memcpy(tmp + got * sch, tmp + (got - 1) * sch, sizeof(float) * sch);
      got++;
      stretched_.fetch_add(1, std::memory_order_relaxed);
    } else {
      got = out_.read(tmp, frames);
    }
    for (size_t f = 0; f < got; f++)
      for (unsigned c = 0; c < sch && cfg_.outOffset + c < dch; c++) out[f * dch + cfg_.outOffset + c] = tmp[f * sch + c];
  }
  played_.fetch_add(frames, std::memory_order_relaxed);
  // ---- loopback ping (replaces the program on the ping channel while running)
  int ps = pingState_.load(std::memory_order_acquire);
  if (ps == 1) { pingState_.store(2, std::memory_order_relaxed); ps = 2; }
  if (ps == 2) {
    for (uint32_t f = 0; f < frames; f++) {
      if (pingOut_ < dch) out[f * dch + pingOut_] = pingPos_ < pingSig_.size() ? pingSig_[pingPos_] : 0.f;
      pingPos_++;
      if (capPos_ < pingCap_.size()) {
        const unsigned ich = cfg_.deviceInChannels;
        pingCap_[capPos_++] = (in && pingIn_ < ich) ? in[f * ich + pingIn_] : 0.f;
      }
    }
    if (capPos_ >= pingCap_.size()) pingState_.store(3, std::memory_order_release);
  }
}

}  // namespace daw3
