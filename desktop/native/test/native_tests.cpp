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

using namespace daw3;

static int gFails = 0, gChecks = 0;
#define CHECK(c)                                                                  \
  do {                                                                            \
    gChecks++;                                                                    \
    if (!(c)) { gFails++; fprintf(stderr, "  FAIL %s:%d  %s\n", __FILE__, __LINE__, #c); } \
  } while (0)
#define CHECK_NEAR(a, b, eps) CHECK(std::fabs((double)(a) - (double)(b)) <= (eps))

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

// ------------------------------------------------------------------------------------- plugins
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
static float runBlock(PluginInstance& p, uint32_t n = 256, const std::vector<MidiEvt>& midi = {}, std::vector<float>* rms = nullptr) {
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
  auto params = p->params();
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
  std::string clap = argc > 1 ? argv[1] : "", vst3 = argc > 2 ? argv[2] : "";
  run("ring buffer", testRing);
  run("json + base64", testJson);
  run("engine: device enumeration (null backend)", testEngineDevices);
  run("engine: routing, drift correction, underruns", testEngineProcess);
  run("engine: loopback ping capture", testEnginePing);
  run("plugin folders", testScanFolders);
  if (!clap.empty()) run("clap: gain + tone test plugins", [&] { testClap(clap); });
  if (!vst3.empty()) run("vst3: gain test plugin", [&] { testVst3(vst3); });
#ifdef __APPLE__
  run("au: Apple AUs (AUDelay, DLSMusicDevice)", testAu);
#endif
  printf("%d checks, %d failures\n", gChecks, gFails);
  return gFails ? 1 : 0;
}
