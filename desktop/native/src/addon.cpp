// daw3_audio.node — N-API addon loaded by the app's audio server (an Electron utility process).
//   audio*: native duplex device I/O (AudioEngine)
//   host*:  the app side of the plugin host's shared-memory block protocol
// Plain C N-API (node_api.h, ABI-stable), so the same binary loads in Node and in Electron.
#include <node_api.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "audio_engine.h"
#include "shm.h"

using namespace daw3;

namespace {

std::unique_ptr<AudioEngine> gEngine;
bool gEngineNull = false;

AudioEngine& engine() {
  if (!gEngine) gEngine.reset(new AudioEngine(gEngineNull));
  return *gEngine;
}

// ------------------------------------------------------------------------------------- napi helpers
#define NAPI_OK(call)                                                   \
  do {                                                                  \
    if ((call) != napi_ok) { throwLast(env); return nullptr; }          \
  } while (0)

void throwLast(napi_env env) {
  const napi_extended_error_info* info = nullptr;
  napi_get_last_error_info(env, &info);
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, nullptr, info && info->error_message ? info->error_message : "N-API call failed");
}

napi_value undef(napi_env env) { napi_value v; napi_get_undefined(env, &v); return v; }
napi_value null(napi_env env) { napi_value v; napi_get_null(env, &v); return v; }
napi_value num(napi_env env, double d) { napi_value v; napi_create_double(env, d, &v); return v; }
napi_value boolean(napi_env env, bool b) { napi_value v; napi_get_boolean(env, b, &v); return v; }
napi_value str(napi_env env, const std::string& s) { napi_value v; napi_create_string_utf8(env, s.c_str(), s.size(), &v); return v; }
void set(napi_env env, napi_value o, const char* k, napi_value v) { napi_set_named_property(env, o, k, v); }

napi_value throwErr(napi_env env, const std::string& msg) { napi_throw_error(env, nullptr, msg.c_str()); return nullptr; }

std::vector<napi_value> args(napi_env env, napi_callback_info info, size_t n) {
  std::vector<napi_value> a(n);
  size_t argc = n;
  napi_get_cb_info(env, info, &argc, a.data(), nullptr, nullptr);
  for (size_t i = argc; i < n; i++) a[i] = undef(env);
  return a;
}

bool isType(napi_env env, napi_value v, napi_valuetype t) { napi_valuetype got; return napi_typeof(env, v, &got) == napi_ok && got == t; }

double getNum(napi_env env, napi_value o, const char* k, double def) {
  if (!isType(env, o, napi_object)) return def;
  napi_value v;
  bool has = false;
  if (napi_has_named_property(env, o, k, &has) != napi_ok || !has) return def;
  napi_get_named_property(env, o, k, &v);
  double d;
  if (napi_get_value_double(env, v, &d) != napi_ok) return def;
  return d;
}

bool getBool(napi_env env, napi_value o, const char* k, bool def) {
  if (!isType(env, o, napi_object)) return def;
  napi_value v;
  bool has = false;
  if (napi_has_named_property(env, o, k, &has) != napi_ok || !has) return def;
  napi_get_named_property(env, o, k, &v);
  bool b;
  if (napi_get_value_bool(env, v, &b) != napi_ok) return def;
  return b;
}

std::string getStr(napi_env env, napi_value o, const char* k, const std::string& def) {
  napi_value v = o;
  if (k) {
    if (!isType(env, o, napi_object)) return def;
    bool has = false;
    if (napi_has_named_property(env, o, k, &has) != napi_ok || !has) return def;
    napi_get_named_property(env, o, k, &v);
  }
  size_t n = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &n) != napi_ok) return def;
  std::string s(n, '\0');
  napi_get_value_string_utf8(env, v, &s[0], n + 1, &n);
  return s;
}

template <class T>
bool typedArray(napi_env env, napi_value v, napi_typedarray_type want, T** data, size_t* len) {
  bool is = false;
  if (napi_is_typedarray(env, v, &is) != napi_ok || !is) return false;
  napi_typedarray_type t;
  void* d;
  napi_value ab;
  size_t off;
  if (napi_get_typedarray_info(env, v, &t, len, &d, &ab, &off) != napi_ok || t != want) return false;
  *data = static_cast<T*>(d);
  return true;
}

napi_value newFloat32(napi_env env, size_t n, float** data) {
  napi_value ab, ta;
  void* d = nullptr;
  if (napi_create_arraybuffer(env, n * sizeof(float), &d, &ab) != napi_ok) return nullptr;
  napi_create_typedarray(env, napi_float32_array, n, ab, 0, &ta);
  *data = static_cast<float*>(d);
  return ta;
}

napi_value newFloat64(napi_env env, size_t n, double** data) {
  napi_value ab, ta;
  void* d = nullptr;
  if (napi_create_arraybuffer(env, n * sizeof(double), &d, &ab) != napi_ok) return nullptr;
  napi_create_typedarray(env, napi_float64_array, n, ab, 0, &ta);
  *data = static_cast<double*>(d);
  return ta;
}

napi_value statsObj(napi_env env, const EngineStats& s) {
  napi_value o;
  napi_create_object(env, &o);
  set(env, o, "running", boolean(env, s.running));
  set(env, o, "sampleRate", num(env, s.sampleRate));
  set(env, o, "bufferFrames", num(env, s.bufferFrames));
  set(env, o, "deviceOutChannels", num(env, s.deviceOutChannels));
  set(env, o, "deviceInChannels", num(env, s.deviceInChannels));
  set(env, o, "streamChannels", num(env, s.streamChannels));
  set(env, o, "targetFrames", num(env, s.targetFrames));
  set(env, o, "callbacks", num(env, (double)s.callbacks));
  set(env, o, "underruns", num(env, (double)s.underruns));
  set(env, o, "overruns", num(env, (double)s.overruns));
  set(env, o, "droppedFrames", num(env, (double)s.droppedFrames));
  set(env, o, "stretchedFrames", num(env, (double)s.stretchedFrames));
  set(env, o, "framesPlayed", num(env, (double)s.framesPlayed));
  set(env, o, "framesCaptured", num(env, (double)s.framesCaptured));
  set(env, o, "outFill", num(env, (double)s.outFill));
  set(env, o, "inFill", num(env, (double)s.inFill));
  set(env, o, "backend", str(env, s.backend));
  set(env, o, "outputName", str(env, s.outputName));
  set(env, o, "inputName", str(env, s.inputName));
  return o;
}

// ------------------------------------------------------------------------------------- audio
napi_value audioInit(napi_env env, napi_callback_info info) {
  auto a = args(env, info, 1);
  const bool nullBackend = getBool(env, a[0], "nullBackend", false);
  if (gEngine) gEngine->close();
  gEngine.reset();
  gEngineNull = nullBackend;
  engine();
  return undef(env);
}

napi_value audioListDevices(napi_env env, napi_callback_info) {
  std::vector<DeviceInfo> devs;
  std::string err;
  if (!engine().listDevices(devs, err)) return throwErr(env, err);
  napi_value arr;
  napi_create_array_with_length(env, devs.size(), &arr);
  for (size_t i = 0; i < devs.size(); i++) {
    const auto& d = devs[i];
    napi_value o, rates;
    napi_create_object(env, &o);
    set(env, o, "id", str(env, d.id));
    set(env, o, "name", str(env, d.name));
    set(env, o, "isInput", boolean(env, d.isInput));
    set(env, o, "isDefault", boolean(env, d.isDefault));
    set(env, o, "maxChannels", num(env, d.maxChannels));
    napi_create_array_with_length(env, d.sampleRates.size(), &rates);
    for (size_t k = 0; k < d.sampleRates.size(); k++) napi_set_element(env, rates, (uint32_t)k, num(env, d.sampleRates[k]));
    set(env, o, "sampleRates", rates);
    napi_set_element(env, arr, (uint32_t)i, o);
  }
  return arr;
}

napi_value audioOpen(napi_env env, napi_callback_info info) {
  auto a = args(env, info, 1);
  EngineConfig c;
  c.outputId = getStr(env, a[0], "outputId", "");
  c.inputId = getStr(env, a[0], "inputId", "");
  c.inputEnabled = getBool(env, a[0], "inputEnabled", true);
  c.sampleRate = (unsigned)getNum(env, a[0], "sampleRate", 48000);
  c.bufferFrames = (unsigned)getNum(env, a[0], "bufferFrames", 256);
  c.deviceOutChannels = (unsigned)getNum(env, a[0], "deviceOutChannels", 2);
  c.deviceInChannels = (unsigned)getNum(env, a[0], "deviceInChannels", 2);
  c.streamChannels = (unsigned)getNum(env, a[0], "streamChannels", 2);
  c.outOffset = (unsigned)getNum(env, a[0], "outOffset", 0);
  c.targetFrames = (unsigned)getNum(env, a[0], "targetFrames", 0);
  std::string err;
  if (!engine().open(c, err)) return throwErr(env, err);
  return statsObj(env, engine().stats());
}

napi_value audioClose(napi_env env, napi_callback_info) {
  if (gEngine) gEngine->close();
  return undef(env);
}

napi_value audioWrite(napi_env env, napi_callback_info info) {
  auto a = args(env, info, 1);
  float* d;
  size_t n;
  if (!typedArray(env, a[0], napi_float32_array, &d, &n)) return throwErr(env, "write(Float32Array) expected");
  const unsigned ch = std::max(1u, engine().stats().streamChannels);
  return num(env, (double)engine().writeOutput(d, n / ch));
}

napi_value audioRead(napi_env env, napi_callback_info info) {
  auto a = args(env, info, 1);
  double maxFrames = 16384;
  napi_get_value_double(env, a[0], &maxFrames);
  AudioEngine& e = engine();
  const unsigned ch = std::max(1u, e.inputChannels());
  size_t n = std::min<size_t>(e.inputAvailable(), (size_t)std::max(0.0, maxFrames));
  float* d;
  napi_value out = newFloat32(env, n * ch, &d);
  if (!out) return throwErr(env, "out of memory");
  if (n) e.readInput(d, n);
  return out;
}

napi_value audioStats(napi_env env, napi_callback_info) { return statsObj(env, engine().stats()); }

napi_value audioStartPing(napi_env env, napi_callback_info info) {
  auto a = args(env, info, 4);
  float* d;
  size_t n;
  if (!typedArray(env, a[0], napi_float32_array, &d, &n)) return throwErr(env, "startPing(Float32Array, outCh, inCh, frames) expected");
  double oc = 0, ic = 0, frames = 48000;
  napi_get_value_double(env, a[1], &oc);
  napi_get_value_double(env, a[2], &ic);
  napi_get_value_double(env, a[3], &frames);
  return boolean(env, engine().startPing(d, n, (unsigned)oc, (unsigned)ic, (size_t)frames));
}

napi_value audioTakePing(napi_env env, napi_callback_info) {
  if (!engine().pingDone()) return null(env);
  std::vector<float> cap = engine().takePing();
  float* d;
  napi_value out = newFloat32(env, cap.size(), &d);
  if (!out) return throwErr(env, "out of memory");
  if (!cap.empty()) std::memcpy(d, cap.data(), cap.size() * sizeof(float));
  return out;
}

// ------------------------------------------------------------------------------------- plugin host client
struct HostChannel {
  ShmRegion shm;
  FifoSignal req, done;
  ShmHeader* h = nullptr;
  std::string shmPath, reqPath, donePath;
};
std::map<int, std::unique_ptr<HostChannel>> gHosts;
int gNextHost = 1;

napi_value hostCreate(napi_env env, napi_callback_info info) {
  auto a = args(env, info, 1);
  const std::string dir = getStr(env, a[0], "dir", "/tmp");
  const uint32_t maxFrames = (uint32_t)getNum(env, a[0], "maxFrames", 2048);
  const uint32_t maxCh = (uint32_t)getNum(env, a[0], "maxChannels", 8);
  const int id = gNextHost++;
  auto ch = std::make_unique<HostChannel>();
  const std::string base = dir + "/daw3-ph-" + std::to_string(getpid()) + "-" + std::to_string(id);
  ch->shmPath = base + ".shm";
  ch->reqPath = base + ".req";
  ch->donePath = base + ".done";
  if (!ch->shm.create(ch->shmPath, shmSize(maxFrames, maxCh))) return throwErr(env, "Could not create the plugin host shared memory");
  if (!ch->req.create(ch->reqPath) || !ch->done.create(ch->donePath)) return throwErr(env, "Could not create the plugin host fifos");
  ch->h = new (ch->shm.ptr()) ShmHeader();
  std::memset((void*)ch->h, 0, sizeof(ShmHeader));
  ch->h->magic = kShmMagic;
  ch->h->version = kShmVersion;
  ch->h->maxFrames = maxFrames;
  ch->h->maxChannels = maxCh;
  ch->h->sampleRate = getNum(env, a[0], "sampleRate", 48000);
  ch->h->reqSeq.store(0);
  ch->h->doneSeq.store(0);
  napi_value o;
  napi_create_object(env, &o);
  set(env, o, "id", num(env, id));
  set(env, o, "shm", str(env, ch->shmPath));
  set(env, o, "req", str(env, ch->reqPath));
  set(env, o, "done", str(env, ch->donePath));
  set(env, o, "maxFrames", num(env, maxFrames));
  set(env, o, "maxChannels", num(env, maxCh));
  gHosts[id] = std::move(ch);
  return o;
}

napi_value hostDestroy(napi_env env, napi_callback_info info) {
  auto a = args(env, info, 1);
  double id = 0;
  napi_get_value_double(env, a[0], &id);
  gHosts.erase((int)id);
  return undef(env);
}

// hostProcess(hostId, { inst, nframes, numIn, numOut, input: Float32Array (planar numIn*nframes),
//   numSc, sidechain: Float32Array (planar numSc*nframes, the aux input bus),
//   midi: Float64Array [offset, status, d1, d2]*, params: Float64Array [offset, id, value]* (sample-accurate,
//   sorted by offset here), playing, tempo, ppq, timeoutMs }) -> { output: Float32Array (planar), status, outParams } | null
napi_value hostProcess(napi_env env, napi_callback_info info) {
  auto a = args(env, info, 2);
  double hid = 0;
  napi_get_value_double(env, a[0], &hid);
  auto it = gHosts.find((int)hid);
  if (it == gHosts.end()) return throwErr(env, "No such plugin host channel");
  HostChannel& c = *it->second;
  ShmHeader* h = c.h;
  napi_value o = a[1];
  const uint32_t nframes = std::min<uint32_t>((uint32_t)getNum(env, o, "nframes", 128), h->maxFrames);
  const uint32_t numIn = std::min<uint32_t>((uint32_t)getNum(env, o, "numIn", 2), h->maxChannels);
  const uint32_t numOut = std::min<uint32_t>((uint32_t)getNum(env, o, "numOut", 2), h->maxChannels);
  const uint32_t numSc = std::min<uint32_t>((uint32_t)getNum(env, o, "numSc", 0), h->maxChannels - numIn);
  const int timeoutMs = (int)getNum(env, o, "timeoutMs", 200);
  h->instId = (uint32_t)getNum(env, o, "inst", 0);
  h->nframes = nframes;
  h->numIn = numIn;
  h->numOut = numOut;
  h->numSc = numSc;
  h->playing = getBool(env, o, "playing", false) ? 1 : 0;
  h->tempo = getNum(env, o, "tempo", 120);
  h->ppqPos = getNum(env, o, "ppq", 0);
  napi_value v;
  bool has = false;
  // audio in
  float* in;
  size_t inLen = 0;
  if (napi_has_named_property(env, o, "input", &has) == napi_ok && has && napi_get_named_property(env, o, "input", &v) == napi_ok &&
      typedArray(env, v, napi_float32_array, &in, &inLen)) {
    for (uint32_t ch = 0; ch < numIn; ch++) {
      float* dst = shmIn(h) + (size_t)ch * h->maxFrames;
      const size_t off = (size_t)ch * nframes;
      if (off + nframes <= inLen) std::memcpy(dst, in + off, nframes * sizeof(float));
      else std::memset(dst, 0, nframes * sizeof(float));
    }
  } else {
    for (uint32_t ch = 0; ch < numIn; ch++) std::memset(shmIn(h) + (size_t)ch * h->maxFrames, 0, nframes * sizeof(float));
  }
  // sidechain (aux input bus): input channels numIn..numIn+numSc
  float* sc;
  size_t scLen = 0;
  const bool haveSc = numSc && napi_has_named_property(env, o, "sidechain", &has) == napi_ok && has && napi_get_named_property(env, o, "sidechain", &v) == napi_ok &&
                      typedArray(env, v, napi_float32_array, &sc, &scLen);
  for (uint32_t ch = 0; ch < numSc; ch++) {
    float* dst = shmIn(h) + (size_t)(numIn + ch) * h->maxFrames;
    const size_t off = (size_t)ch * nframes;
    if (haveSc && off + nframes <= scLen) std::memcpy(dst, sc + off, nframes * sizeof(float));
    else std::memset(dst, 0, nframes * sizeof(float));
  }
  // midi events
  h->midiCount = 0;
  double* md;
  size_t mlen = 0;
  if (napi_has_named_property(env, o, "midi", &has) == napi_ok && has && napi_get_named_property(env, o, "midi", &v) == napi_ok &&
      typedArray(env, v, napi_float64_array, &md, &mlen)) {
    for (size_t i = 0; i + 3 < mlen && h->midiCount < kMaxMidi; i += 4) {
      ShmMidi& m = h->midi[h->midiCount++];
      m.offset = (uint32_t)md[i];
      m.data[0] = (uint8_t)md[i + 1];
      m.data[1] = (uint8_t)md[i + 2];
      m.data[2] = (uint8_t)md[i + 3];
    }
  }
  h->paramCount = 0;
  double* pd;
  size_t plen = 0;
  if (napi_has_named_property(env, o, "params", &has) == napi_ok && has && napi_get_named_property(env, o, "params", &v) == napi_ok &&
      typedArray(env, v, napi_float64_array, &pd, &plen)) {
    for (size_t i = 0; i + 2 < plen && h->paramCount < kMaxParamEvents; i += 3)
      h->params[h->paramCount++] = {(uint32_t)std::min<double>(std::max(0.0, pd[i]), nframes ? nframes - 1 : 0), (uint32_t)pd[i + 1], pd[i + 2]};
    // plugins expect each parameter's points in time order (VST3 queues, CLAP event lists)
    std::stable_sort(h->params, h->params + h->paramCount, [](const ShmParam& a, const ShmParam& b) { return a.offset < b.offset; });
  }
  h->status = kShmError;
  h->outParamCount = 0;
  const uint64_t seq = h->reqSeq.load() + 1;
  h->reqSeq.store(seq, std::memory_order_release);
  c.req.post();
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  while (h->doneSeq.load(std::memory_order_acquire) != seq) {
    const int left = (int)std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count();
    if (left <= 0) return null(env);  // hung / crashed host
    c.done.wait(left);
  }
  napi_value res;
  napi_create_object(env, &res);
  float* out;
  napi_value outArr = newFloat32(env, (size_t)numOut * nframes, &out);
  for (uint32_t ch = 0; ch < numOut; ch++) std::memcpy(out + (size_t)ch * nframes, shmOut(h) + (size_t)ch * h->maxFrames, nframes * sizeof(float));
  set(env, res, "output", outArr);
  set(env, res, "status", num(env, h->status));
  double* op = nullptr;
  const uint32_t opc = std::min(h->outParamCount, kMaxParamEvents);
  napi_value opArr = newFloat64(env, (size_t)opc * 3, &op);
  for (uint32_t i = 0; i < opc; i++) { op[3 * i] = h->outParams[i].offset; op[3 * i + 1] = h->outParams[i].id; op[3 * i + 2] = h->outParams[i].value; }
  set(env, res, "outParams", opArr);
  return res;
}

napi_value Init(napi_env env, napi_value exports) {
  struct Fn { const char* name; napi_callback cb; } fns[] = {
      {"audioInit", audioInit}, {"audioListDevices", audioListDevices}, {"audioOpen", audioOpen}, {"audioClose", audioClose},
      {"audioWrite", audioWrite}, {"audioRead", audioRead}, {"audioStats", audioStats}, {"audioStartPing", audioStartPing},
      {"audioTakePing", audioTakePing}, {"hostCreate", hostCreate}, {"hostDestroy", hostDestroy}, {"hostProcess", hostProcess},
  };
  for (auto& f : fns) {
    napi_value fn;
    napi_create_function(env, f.name, NAPI_AUTO_LENGTH, f.cb, nullptr, &fn);
    napi_set_named_property(env, exports, f.name, fn);
  }
  set(env, exports, "version", str(env, "1.0.0"));
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
