// Native unit tests (run in CI on macOS, and on Linux with the null audio backend):
//   ring buffer, JSON/base64, audio engine (enumeration on the null backend, drift correction,
//   underruns, loopback ping), CLAP + VST3 hosting of the test plugins, AU hosting of Apple's
//   built-in AUs (macOS). Usage: native_tests <gain.clap> <gain.vst3>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <string>
#include <thread>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/host/json.h"
#include "../src/host/plugin.h"
#include "../src/ring.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <unistd.h>

// .vstpreset helpers (header-only, shared with the VST3 host)
#include "../src/host/vst3_common.h"
static bool v3parse(const std::vector<uint8_t>& d, std::string& c, std::vector<uint8_t>& a, std::vector<uint8_t>& b) { return daw3::v3::parseVstPreset(d, c, a, b); }
static std::vector<uint8_t> v3make(const std::string& c, const std::vector<uint8_t>& a, const std::vector<uint8_t>& b) { return daw3::v3::makeVstPreset(c, a, b); }

using namespace daw3;

#include "check.h"
int gFails = 0, gChecks = 0;

static void run(const char* name, std::function<void()> fn) {
  int before = gFails;
  fn();
  printf("%s %s\n", gFails == before ? "ok  " : "FAIL", name);
}

// ------------------------------------------------------------------------------------- ring
static void testRing() {
  FrameRing r;
  r.reset(5, 2);  // -> 8 frames
  CHECK(r.capacity() == 8);
  float in[20], out[20];
  for (int i = 0; i < 20; i++) in[i] = (float)i;
  CHECK(r.write(in, 6) == 6);
  CHECK(r.available() == 6 && r.space() == 2);
  CHECK(r.write(in, 6) == 2);  // only 2 fit
  CHECK(r.read(out, 4) == 4);
  CHECK(out[0] == 0 && out[7] == 7);
  CHECK(r.write(in + 12, 4) == 4);  // wraps
  CHECK(r.read(out, 8) == 8);
  CHECK(out[0] == 8 && out[3] == 11);  // frames 4,5 of first write
  CHECK(out[4] == 0 && out[5] == 1);   // the 2 frames that fit from the second write
  CHECK(out[8] == 12 && out[15] == 19);
  CHECK(r.available() == 0);
  // threaded: producer/consumer agree on every sample
  FrameRing t;
  t.reset(256, 1);
  const int N = 200000;
  std::thread prod([&] {
    float v[37];
    int k = 0;
    while (k < N) {
      int n = std::min(37, N - k);
      for (int i = 0; i < n; i++) v[i] = (float)(k + i);
      k += (int)t.write(v, n);
    }
  });
  int k = 0, bad = 0;
  float buf[53];
  while (k < N) {
    size_t n = t.read(buf, 53);
    for (size_t i = 0; i < n; i++) if (buf[i] != (float)(k + (int)i)) bad++;
    k += (int)n;
  }
  prod.join();
  CHECK(bad == 0);
}

// ------------------------------------------------------------------------------------- json
static void testJson() {
  bool ok = false;
  Json j = Json::parse(R"({"a":1,"b":[true,null,"x\né"],"c":{"d":-2.5e3}})", &ok);
  CHECK(ok);
  CHECK(j["a"].num() == 1);
  CHECK(j["b"].items().size() == 3 && j["b"].items()[0].boolean());
  CHECK(j["b"].items()[2].str() == "x\n\xc3\xa9");
  CHECK(j["c"]["d"].num() == -2500);
  Json back = Json::parse(j.dump(), &ok);
  CHECK(ok && back.dump() == j.dump());
  Json::parse("{bad", &ok);
  CHECK(!ok);
  std::vector<uint8_t> bytes;
  for (int i = 0; i < 300; i++) bytes.push_back((uint8_t)(i * 7));
  for (size_t n : {0, 1, 2, 3, 299}) {
    std::vector<uint8_t> part(bytes.begin(), bytes.begin() + (long)n);
    CHECK(base64Decode(base64Encode(part)) == part);
  }
  CHECK(base64Encode({'h', 'i'}) == "aGk=");
}

// ------------------------------------------------------------------------------------- engine
static void testEngineDevices() {
  AudioEngine e(true);  // null backend: a "mock" device set every machine has
  std::vector<DeviceInfo> devs;
  std::string err;
  CHECK(e.listDevices(devs, err));
  bool out = false, in = false;
  for (auto& d : devs) { out |= !d.isInput; in |= d.isInput; CHECK(!d.id.empty()); CHECK(!d.name.empty()); CHECK(d.maxChannels >= 1); }
  CHECK(out && in);
  // open the null device in duplex and let it run briefly
  EngineConfig c;
  c.sampleRate = 48000;
  c.bufferFrames = 128;
  CHECK(e.open(c, err));
  std::this_thread::sleep_for(std::chrono::milliseconds(80));
  EngineStats s = e.stats();
  CHECK(s.running);
  CHECK(s.callbacks > 0);
  CHECK(s.backend == "Null");
  e.close();
  CHECK(!e.stats().running);
}

static void testEngineProcess() {
  AudioEngine e(true);
  EngineConfig c;
  c.sampleRate = 48000;
  c.bufferFrames = 64;
  c.deviceOutChannels = 4;
  c.deviceInChannels = 2;
  c.streamChannels = 2;
  c.outOffset = 2;  // stream lands on device channels 3/4
  c.targetFrames = 256;
  e.prepare(c);
  std::vector<float> out(64 * 4), in(64 * 2, 0.5f), src(512 * 2);
  for (size_t i = 0; i < src.size(); i++) src[i] = 0.25f;
  // priming: nothing plays until the target fill is reached
  e.writeOutput(src.data(), 100);
  e.process(out.data(), in.data(), 64);
  CHECK(out[2] == 0.f);
  e.writeOutput(src.data(), 200);  // 300 >= target
  e.process(out.data(), in.data(), 64);
  CHECK(out[0] == 0.f && out[1] == 0.f && out[2] == 0.25f && out[3] == 0.25f);
  // inputs are captured
  std::vector<float> got(64 * 2);
  CHECK(e.readInput(got.data(), 64) == 64);
  CHECK(got[0] == 0.5f);
  // producer far ahead -> drops frames, far behind -> stretches
  e.writeOutput(src.data(), 512);
  const uint64_t d0 = e.stats().droppedFrames;
  e.process(out.data(), in.data(), 64);
  CHECK(e.stats().droppedFrames == d0 + 1);
  while (e.stats().outFill > 140) e.process(out.data(), in.data(), 64);
  const uint64_t s0 = e.stats().stretchedFrames;
  e.process(out.data(), in.data(), 64);
  CHECK(e.stats().stretchedFrames >= s0 + 1);
  // starve -> underrun, then re-prime
  while (e.stats().outFill > 0) e.process(out.data(), in.data(), 64);
  const uint64_t u0 = e.stats().underruns;
  e.process(out.data(), in.data(), 64);
  e.process(out.data(), in.data(), 64);
  CHECK(e.stats().underruns >= u0);
  CHECK(out[2] == 0.f);
}

static void testEnginePing() {
  // simulated loopback cable with a 300-frame round trip: what goes out on ch 0 comes back on input ch 1
  AudioEngine e(true);
  EngineConfig c;
  c.bufferFrames = 128;
  c.deviceOutChannels = 2;
  c.deviceInChannels = 2;
  e.prepare(c);
  std::vector<float> sig(64);
  for (int i = 0; i < 64; i++) sig[i] = std::sin(i * 0.7f) * (1 - i / 64.f);
  CHECK(e.startPing(sig.data(), sig.size(), 0, 1, 2048));
  const int D = 300;
  std::vector<float> delay(D + 4096, 0.f);
  size_t t = 0;
  std::vector<float> out(128 * 2), in(128 * 2);
  for (int k = 0; k < 40 && !e.pingDone(); k++) {
    for (int f = 0; f < 128; f++) { in[f * 2] = 0; in[f * 2 + 1] = t + f >= (size_t)D ? delay[t + f - D] : 0.f; }
    e.process(out.data(), in.data(), 128);
    for (int f = 0; f < 128; f++) delay[t + f] = out[f * 2];
    t += 128;
    if (t + 128 > delay.size()) break;
  }
  CHECK(e.pingDone());
  std::vector<float> cap = e.takePing();
  CHECK(cap.size() == 2048);
  // the captured buffer holds the signal starting at frame D (the JS side finds it by correlation)
  int best = -1;
  double bestV = 0;
  for (int lag = 0; lag + 64 < (int)cap.size(); lag++) {
    double acc = 0;
    for (int i = 0; i < 64; i++) acc += cap[lag + i] * sig[i];
    if (acc > bestV) { bestV = acc; best = lag; }
  }
  CHECK(best == D);
}

static void testEngineRenegotiate() {
  // sample-rate / buffer changes reopen the device without restarting anything else
  AudioEngine e(true);
  EngineConfig c;
  c.sampleRate = 48000;
  c.bufferFrames = 256;
  std::string err;
  CHECK(e.open(c, err));
  std::this_thread::sleep_for(std::chrono::milliseconds(40));
  CHECK(e.stats().sampleRate == 48000);
  const uint64_t cb48 = e.stats().callbacks;
  CHECK(cb48 > 0);
  c.sampleRate = 96000;
  c.bufferFrames = 128;
  CHECK(e.open(c, err));  // replaces the running stream
  EngineStats s = e.stats();
  CHECK(s.running);
  CHECK(s.sampleRate == 96000);
  CHECK(s.callbacks < cb48 + 1000);  // counters restart with the new stream
  std::this_thread::sleep_for(std::chrono::milliseconds(60));
  CHECK(e.stats().callbacks > 0);
  CHECK(e.stats().targetFrames == 128 + 96000 / 100);  // the bridge target follows the new rate
  // the ring accepts / plays audio at the new rate
  std::vector<float> src(512 * 2, 0.1f);
  CHECK(e.writeOutput(src.data(), 512) == 512);
  c.sampleRate = 44100;
  CHECK(e.open(c, err));
  CHECK(e.stats().sampleRate == 44100);
  e.close();
}

// ------------------------------------------------------------------------------------- plugins
static std::unique_ptr<PluginInstance> loadNamed(PluginFormat& f, const std::string& path, const std::string& name) {
  std::vector<PluginDesc> list;
  std::string err;
  if (!f.describe(path, list, err)) { fprintf(stderr, "  describe failed: %s\n", err.c_str()); return nullptr; }
  for (auto& d : list) {
    if (d.name != name) continue;
    auto inst = f.create(d, err);
    if (!inst) fprintf(stderr, "  create failed: %s\n", err.c_str());
    return inst;
  }
  fprintf(stderr, "  %s not found\n", name.c_str());
  return nullptr;
}

/** One block through a plugin with every bus spelled out. Returns the planar outputs (numOut channels). */
static std::vector<std::vector<float>> runBlockEx(PluginInstance& p, uint32_t n, float inLevel, uint32_t numOut, const std::vector<ParamEvt>& params = {},
                                                  const std::vector<MidiEvt>& midi = {}, float scLevel = -1, uint32_t numSc = 0) {
  std::vector<float> a(n, inLevel), b(n, inLevel), sa(n, scLevel), sb(n, scLevel);
  std::vector<std::vector<float>> outs(numOut, std::vector<float>(n, 9.f));
  std::vector<float*> op;
  for (auto& o : outs) op.push_back(o.data());
  const float* ins[2] = {a.data(), b.data()};
  const float* scs[2] = {sa.data(), sb.data()};
  std::vector<ParamEvt> outParams;
  outParams.reserve(64);
  ProcessBlock blk;
  blk.nframes = n;
  blk.numIn = 2;
  blk.numOut = numOut;
  blk.in = ins;
  blk.out = op.data();
  blk.sc = scLevel >= 0 ? scs : nullptr;
  blk.numSc = scLevel >= 0 ? numSc : 0;
  blk.midi = midi.data();
  blk.midiCount = (uint32_t)midi.size();
  blk.params = params.data();
  blk.paramCount = (uint32_t)params.size();
  blk.outParams = &outParams;
  p.process(blk);
  return outs;
}

static double rmsOf(const std::vector<float>& v, size_t from = 0) {
  double s = 0;
  for (size_t i = from; i < v.size(); i++) s += v[i] * v[i];
  return std::sqrt(s / std::max<size_t>(1, v.size() - from));
}

static std::unique_ptr<PluginInstance> loadFirst(PluginFormat& f, const std::string& path, bool instrument, PluginDesc* outDesc = nullptr) {
  std::vector<PluginDesc> list;
  std::string err;
  if (!f.describe(path, list, err)) { fprintf(stderr, "  describe failed: %s\n", err.c_str()); return nullptr; }
  for (auto& d : list) {
    if (d.instrument != instrument) continue;
    if (outDesc) *outDesc = d;
    auto inst = f.create(d, err);
    if (!inst) fprintf(stderr, "  create failed: %s\n", err.c_str());
    return inst;
  }
  return nullptr;
}

/** Runs one block of a constant 0.5 through the plugin; returns the first output sample. */
float runBlock(PluginInstance& p, uint32_t n = 256, const std::vector<MidiEvt>& midi = {}, std::vector<float>* rms = nullptr) {
  std::vector<float> a(n, 0.5f), b(n, 0.5f), oa(n, 9.f), ob(n, 9.f);
  const float* ins[2] = {a.data(), b.data()};
  float* outs[2] = {oa.data(), ob.data()};
  std::vector<ParamEvt> outParams;
  outParams.reserve(64);
  ProcessBlock blk;
  blk.nframes = n;
  blk.numIn = 2;
  blk.numOut = 2;
  blk.in = ins;
  blk.out = outs;
  blk.midi = midi.data();
  blk.midiCount = (uint32_t)midi.size();
  blk.outParams = &outParams;
  p.process(blk);
  if (rms) {
    double s = 0;
    for (float v : oa) s += v * v;
    rms->push_back((float)std::sqrt(s / n));
  }
  return oa[n / 2];
}

static void testPluginFormat(PluginFormat& f, const std::string& path, double gainParamFor2x, uint32_t expectLatency) {
  PluginDesc d;
  auto p = loadFirst(f, path, false, &d);
  CHECK(p != nullptr);
  if (!p) return;
  CHECK(d.name.find("daW3 Test Gain") == 0);
  CHECK(d.vendor == "daW3");
  CHECK(!d.instrument);
  std::string err;
  CHECK(p->activate(48000, 512, err));
  CHECK(p->desc().numInputs == 2 && p->desc().numOutputs == 2);
  CHECK(p->latency() == expectLatency);
  auto all = p->params();
  std::vector<ParamInfo> params;
  for (auto& pi : all) if (!(pi.flags & kParamHidden)) params.push_back(pi);
  CHECK(params.size() == 1);
  if (params.empty()) return;
  CHECK(params[0].name == "Gain");
  CHECK(params[0].flags & kParamAutomatable);
  CHECK_NEAR(runBlock(*p), 0.5f, 1e-6);  // unity at the default
  p->setParam(params[0].id, gainParamFor2x);
  CHECK_NEAR(runBlock(*p), 1.0f, 1e-6);
  CHECK_NEAR(p->getParam(params[0].id), gainParamFor2x, 1e-6);
  // state round trip into a fresh instance
  std::vector<uint8_t> st;
  CHECK(p->getState(st));
  CHECK(!st.empty());
  auto q = loadFirst(f, path, false);
  CHECK(q != nullptr);
  if (!q) return;
  CHECK(q->activate(48000, 512, err));
  CHECK_NEAR(runBlock(*q), 0.5f, 1e-6);
  CHECK(q->setState(base64Decode(base64Encode(st))));
  CHECK_NEAR(q->getParam(params[0].id), gainParamFor2x, 1e-6);
  CHECK_NEAR(runBlock(*q), 1.0f, 1e-6);
  CHECK(!q->setState({1, 2, 3}));
  q->deactivate();
  p->deactivate();
}

static void testClap(const std::string& path) {
  auto f = makeClapFormat();
  testPluginFormat(*f, path, 2.0, 64);
  // instrument: silent until a note, sine while held, silent after note off
  auto t = loadFirst(*f, path, true);
  CHECK(t != nullptr);
  if (!t) return;
  std::string err;
  CHECK(t->activate(48000, 512, err));
  CHECK(t->desc().midiInput);
  std::vector<float> rms;
  runBlock(*t, 256, {}, &rms);
  runBlock(*t, 256, {{10, {0x90, 69, 100}}}, &rms);
  runBlock(*t, 256, {}, &rms);
  runBlock(*t, 256, {{0, {0x80, 69, 0}}}, &rms);
  CHECK(rms[0] == 0.f);
  CHECK(rms[1] > 0.05f);
  CHECK_NEAR(rms[2], 0.25 / std::sqrt(2.0), 0.01);
  CHECK(rms[3] == 0.f);
}

static void testVst3(const std::string& path) {
  auto f = makeVst3Format();
  testPluginFormat(*f, path, 1.0, 32);  // normalized 1.0 = 2x
}

static void testParamOffsets(PluginFormat& f, const std::string& path, uint32_t gainId, double from, double to, float expectFrom, float expectTo);
static void testSidechain(PluginFormat& f, const std::string& path, const std::string& name);
static void testMultiOut(const std::string& clapPath);

static void testClapBuses(const std::string& clap) {
  auto f = makeClapFormat();
  testParamOffsets(*f, clap, 1, 1.0, 2.0, 0.5f, 1.0f);
  testSidechain(*f, clap, "daW3 Test Duck");
  testMultiOut(clap);
}

static void testVst3Buses(const std::string& vst3) {
  auto f = makeVst3Format();
  testParamOffsets(*f, vst3, 0, 0.5, 1.0, 0.5f, 1.0f);
  testSidechain(*f, vst3, "daW3 Test Duck (VST3)");
}

/** Sample-accurate parameter automation: a change at offset 100 of a 256-frame block lands on sample 100. */
static void testParamOffsets(PluginFormat& f, const std::string& path, uint32_t gainId, double from, double to, float expectFrom, float expectTo) {
  auto p = loadFirst(f, path, false);
  CHECK(p != nullptr);
  if (!p) return;
  std::string err;
  CHECK(p->activate(48000, 512, err));
  auto o = runBlockEx(*p, 256, 0.5f, 2, {{0, gainId, from}});
  CHECK_NEAR(o[0][0], expectFrom, 1e-6);
  CHECK_NEAR(o[0][255], expectFrom, 1e-6);
  // two changes inside one block (what an automation ramp sends): each lands on its own sample
  o = runBlockEx(*p, 256, 0.5f, 2, {{100, gainId, to}, {200, gainId, from}});
  CHECK_NEAR(o[0][99], expectFrom, 1e-6);
  CHECK_NEAR(o[0][100], expectTo, 1e-6);
  CHECK_NEAR(o[1][150], expectTo, 1e-6);
  CHECK_NEAR(o[0][199], expectTo, 1e-6);
  CHECK_NEAR(o[0][200], expectFrom, 1e-6);
  // the last value sticks into the next block
  o = runBlockEx(*p, 128, 0.5f, 2, {{64, gainId, to}});
  CHECK_NEAR(o[0][63], expectFrom, 1e-6);
  CHECK_NEAR(o[0][64], expectTo, 1e-6);
  CHECK_NEAR(runBlockEx(*p, 64, 0.5f, 2)[0][0], expectTo, 1e-6);
  p->deactivate();
}

/** A sidechain (aux input bus) plugin: the key ducks the main input. */
static void testSidechain(PluginFormat& f, const std::string& path, const std::string& name) {
  auto p = loadNamed(f, path, name);
  CHECK(p != nullptr);
  if (!p) return;
  std::string err;
  CHECK(p->activate(48000, 512, err));
  CHECK(p->desc().sidechainChannels == 2);
  CHECK(p->desc().numInputs == 2);
  CHECK(p->desc().toJson()["sidechain"].num() == 2);
  CHECK_NEAR(runBlockEx(*p, 128, 0.5f, 2)[0][10], 0.5f, 1e-6);                  // no key: unity
  CHECK_NEAR(runBlockEx(*p, 128, 0.5f, 2, {}, {}, 0.5f, 2)[1][10], 0.25f, 1e-6);  // key 0.5 -> half
  CHECK_NEAR(runBlockEx(*p, 128, 0.5f, 2, {}, {}, 1.0f, 2)[0][10], 0.0f, 1e-6);   // key at full scale -> silence
  CHECK_NEAR(runBlockEx(*p, 128, 0.5f, 2, {}, {}, 0.5f, 1)[1][10], 0.25f, 1e-6);  // a mono key feeds both key channels
  // the sidechain survives a re-activation (sample-rate change)
  CHECK(p->activate(96000, 256, err));
  CHECK(p->desc().sidechainChannels == 2);
  CHECK_NEAR(runBlockEx(*p, 128, 0.5f, 2, {}, {}, 0.5f, 2)[0][3], 0.25f, 1e-6);
  p->deactivate();
}

/** Multi-out instrument: the tone plugin's second output port carries the same sine at half level. */
static void testMultiOut(const std::string& clapPath) {
  auto f = makeClapFormat();
  auto t = loadNamed(*f, clapPath, "daW3 Test Tone");
  CHECK(t != nullptr);
  if (!t) return;
  std::string err;
  CHECK(t->activate(48000, 512, err));
  const PluginDesc& d = t->desc();
  CHECK(d.outputBuses.size() == 2);
  CHECK(d.totalOutputs() == 4);
  if (d.outputBuses.size() == 2) { CHECK(d.outputBuses[0].name == "Out"); CHECK(d.outputBuses[1].name == "Aux"); CHECK(d.outputBuses[1].channels == 2); }
  CHECK(d.toJson()["outputBuses"].items().size() == 2);
  CHECK(d.toJson()["totalOutputs"].num() == 4);
  auto o = runBlockEx(*t, 512, 0, 4, {}, {{0, {0x90, 69, 100}}});
  const double main = rmsOf(o[0]), aux = rmsOf(o[2]);
  CHECK(main > 0.1);
  CHECK_NEAR(aux, main / 2, 1e-4);
  CHECK_NEAR(rmsOf(o[3]), rmsOf(o[1]) / 2, 1e-4);
  // a host that only takes the main bus still gets it (the aux bus goes to scratch)
  o = runBlockEx(*t, 512, 0, 2);
  CHECK(rmsOf(o[0]) > 0.1);
  t->deactivate();
}

/** Re-activation at a new sample rate: the tone plugin's 440 Hz stays 440 Hz. */
static void testSampleRateChange(const std::string& clapPath) {
  auto f = makeClapFormat();
  auto t = loadNamed(*f, clapPath, "daW3 Test Tone");
  CHECK(t != nullptr);
  if (!t) return;
  std::string err;
  auto crossings = [&](double sr) {
    CHECK(t->activate(sr, 1024, err));
    int n = 0;
    float last = 0;
    const uint32_t frames = (uint32_t)sr / 4;  // 0.25 s -> 110 periods -> 220 zero crossings
    std::vector<MidiEvt> on = {{0, {0x90, 69, 100}}};
    for (uint32_t done = 0; done < frames; done += 1000) {
      auto o = runBlockEx(*t, std::min<uint32_t>(1000, frames - done), 0, 2, {}, done ? std::vector<MidiEvt>{} : on);
      for (float v : o[0]) { if ((v >= 0) != (last >= 0) && last != 0) n++; last = v; }
    }
    runBlockEx(*t, 16, 0, 2, {}, {{0, {0x80, 69, 0}}});
    return n;
  };
  const int c48 = crossings(48000), c96 = crossings(96000), c44 = crossings(44100);
  CHECK(std::abs(c48 - 220) <= 2);
  CHECK(std::abs(c96 - 220) <= 2);
  CHECK(std::abs(c44 - 220) <= 2);
  t->deactivate();
}

static std::string tempDir(const char* tag) {
  char tmpl[256];
  snprintf(tmpl, sizeof tmpl, "/tmp/daw3-%s-XXXXXX", tag);
  const char* d = mkdtemp(tmpl);
  return d ? d : "/tmp";
}

/** CLAP preset discovery (factory presets of the plugin + files) and preset-load. */
static void testClapPresets(const std::string& clapPath) {
  const std::string dir = tempDir("clap-presets");
  writeFile(dir + "/Quiet.d3gain", {'0', '.', '2', '5'});
  writeFile(dir + "/Sub/Loud.d3gain", {'1', '.', '5'});
  writeFile(dir + "/notes.txt", {'x'});
  setenv("DAW3_TEST_PRESET_DIR", dir.c_str(), 1);
  auto f = makeClapFormat();
  auto p = loadNamed(*f, clapPath, "daW3 Test Gain");
  CHECK(p != nullptr);
  if (!p) return;
  std::string err;
  CHECK(p->activate(48000, 512, err));
  auto list = p->presets();
  std::vector<std::string> names;
  for (auto& pr : list) names.push_back(pr.kind + ":" + pr.name + (pr.category.empty() ? "" : "@" + pr.category));
  CHECK(list.size() == 5);  // 3 factory (the tone plugin's preset is filtered out) + 2 files
  CHECK(std::find(names.begin(), names.end(), "factory:Double@Factory") != names.end());
  CHECK(std::find(names.begin(), names.end(), "file:Quiet@User") != names.end());
  CHECK(std::find(names.begin(), names.end(), "file:Loud@Sub") != names.end());
  for (auto& n : names) CHECK(n.find("Tone") == std::string::npos);
  auto find = [&](const std::string& name) { for (auto& pr : list) if (pr.name == name) return pr.id; return std::string(); };
  CHECK(p->loadPreset(find("Double"), err));
  CHECK_NEAR(p->getParam(1), 2.0, 1e-9);
  CHECK_NEAR(runBlockEx(*p, 64, 0.5f, 2)[0][10], 1.0f, 1e-6);
  CHECK(p->loadPreset(find("Quiet"), err));
  CHECK_NEAR(p->getParam(1), 0.25, 1e-9);
  CHECK(!p->loadPreset("1\x1f\x1fnope", err));
  CHECK(!err.empty());
  // the tone plugin has no preset-load extension: listing works, loading says so
  auto t = loadNamed(*f, clapPath, "daW3 Test Tone");
  if (t) {
    auto tl = t->presets();
    CHECK(tl.size() == 1 && tl[0].name == "Tone preset");
    CHECK(!t->loadPreset(tl.empty() ? "" : tl[0].id, err));
  }
  unsetenv("DAW3_TEST_PRESET_DIR");
}

/** VST3 programs (IUnitInfo + program-change parameter) and .vstpreset files (save / list / load). */
static void testVst3Presets(const std::string& vst3Path) {
  const std::string root = tempDir("vst3-presets");
  setenv("DAW3_PRESET_DIRS", root.c_str(), 1);
  auto f = makeVst3Format();
  auto p = loadNamed(*f, vst3Path, "daW3 Test Gain (VST3)");
  CHECK(p != nullptr);
  if (!p) return;
  std::string err;
  CHECK(p->activate(48000, 512, err));
  auto list = p->presets();
  CHECK(list.size() == 3);
  if (list.size() == 3) {
    CHECK(list[1].name == "Double" && list[1].kind == "factory" && list[1].category == "Factory");
    CHECK(p->loadPreset(list[1].id, err));
    CHECK_NEAR(runBlockEx(*p, 64, 0.5f, 2)[0][10], 1.0f, 1e-6);  // processor follows the program change
    CHECK(p->loadPreset(list[2].id, err));
    CHECK_NEAR(runBlockEx(*p, 64, 0.5f, 2)[0][10], 0.0f, 1e-6);
  }
  // save the current state (gain 0.75 normalized = x1.5) as a .vstpreset in the plugin's preset folder
  p->setParam(0, 0.75);
  runBlockEx(*p, 16, 0.5f, 2);
  const std::string file = presetFolders(p->desc())[0] + "/Mine/Warm.vstpreset";
  CHECK(p->savePreset(file, err));
  std::vector<uint8_t> raw;
  CHECK(readFile(file, raw));
  std::string cls;
  std::vector<uint8_t> comp, cont;
  CHECK(v3parse(raw, cls, comp, cont));
  CHECK(cls == p->desc().uid);
  CHECK(comp.size() == 4);
  // a preset of another class in the same folder is not listed
  writeFile(presetFolders(p->desc())[0] + "/Other.vstpreset", v3make("00000000000000000000000000000000", comp, {}));
  p->setParam(0, 0.5);
  runBlockEx(*p, 16, 0.5f, 2);
  list = p->presets();
  CHECK(list.size() == 4);
  std::string id;
  for (auto& pr : list) if (pr.kind == "file") { CHECK(pr.name == "Warm"); CHECK(pr.category == "Mine"); id = pr.id; }
  CHECK(p->loadPreset(id, err));
  CHECK_NEAR(p->getParam(0), 0.75, 1e-6);
  CHECK_NEAR(runBlockEx(*p, 64, 0.5f, 2)[0][10], 0.75f, 1e-6);
  CHECK(!p->loadPreset("file:" + root + "/missing.vstpreset", err));
  unsetenv("DAW3_PRESET_DIRS");
}

/** daw3-link: the Ableton Link process answers the bridge protocol (tempo / quantum / play) on stdout. */
static void testLinkProcess(const std::string& bin) {
  const std::string cmd = "printf '%s\\n' '{\"type\":\"tempo\",\"bpm\":133.5}' '{\"type\":\"quantum\",\"value\":3}' 'junk' '{\"type\":\"play\"}' | \"" + bin + "\"";
  FILE* f = popen(cmd.c_str(), "r");
  CHECK(f != nullptr);
  if (!f) return;
  std::string out;
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
  CHECK(pclose(f) == 0);
  std::vector<Json> lines;
  size_t a = 0;
  while (a < out.size()) {
    size_t b = out.find('\n', a);
    if (b == std::string::npos) b = out.size();
    bool ok = false;
    Json j = Json::parse(out.substr(a, b - a), &ok);
    if (ok) lines.push_back(j);
    a = b + 1;
  }
  CHECK(lines.size() >= 2);
  if (lines.size() < 2) return;
  CHECK(lines.front()["type"].str() == "ready");
  const Json& last = lines.back();
  CHECK(last["type"].str() == "state");
  CHECK(last["link"].boolean());
  CHECK_NEAR(last["tempo"].num(), 133.5, 1e-6);
  CHECK(last["quantum"].num() == 3);
  CHECK(last["playing"].boolean());
  CHECK(last["phase"].num() >= 0 && last["phase"].num() < 3);
  CHECK(last["time"].num() > 1.6e12);  // wall-clock ms (JavaScript Date.now())
}

static void testScanFolders() {
  auto c = makeClapFormat();
  auto v = makeVst3Format();
  CHECK(!c->defaultPaths().empty());
  CHECK(!v->defaultPaths().empty());
#ifdef __APPLE__
  CHECK(c->defaultPaths()[1] == "/Library/Audio/Plug-Ins/CLAP");
  CHECK(v->defaultPaths()[1] == "/Library/Audio/Plug-Ins/VST3");
#endif
}

#ifdef __APPLE__
void testAu();  // test_au.mm
#endif

int main(int argc, char** argv) {
  std::string clap = argc > 1 ? argv[1] : "", vst3 = argc > 2 ? argv[2] : "", link = argc > 3 ? argv[3] : "";
  run("ring buffer", testRing);
  run("json + base64", testJson);
  run("engine: device enumeration (null backend)", testEngineDevices);
  run("engine: routing, drift correction, underruns", testEngineProcess);
  run("engine: loopback ping capture", testEnginePing);
  run("engine: sample-rate / buffer renegotiation (null backend)", testEngineRenegotiate);
  run("plugin folders", testScanFolders);
  if (!clap.empty()) run("clap: gain + tone test plugins", [&] { testClap(clap); });
  if (!vst3.empty()) run("vst3: gain test plugin", [&] { testVst3(vst3); });
  if (!clap.empty()) run("clap: sample-accurate params, sidechain bus, multi-out", [&] { testClapBuses(clap); });
  if (!vst3.empty()) run("vst3: sample-accurate params, sidechain (aux) bus", [&] { testVst3Buses(vst3); });
  if (!clap.empty()) run("clap: re-activation at a new sample rate", [&] { testSampleRateChange(clap); });
  if (!clap.empty()) run("clap: preset discovery + preset-load", [&] { testClapPresets(clap); });
  if (!vst3.empty()) run("vst3: programs + .vstpreset files", [&] { testVst3Presets(vst3); });
  if (!link.empty()) run("link: daw3-link process (Ableton Link)", [&] { testLinkProcess(link); });
#ifdef __APPLE__
  run("au: Apple AUs (AUDelay, DLSMusicDevice)", testAu);
#endif
  printf("%d checks, %d failures\n", gChecks, gFails);
  return gFails ? 1 : 0;
}
