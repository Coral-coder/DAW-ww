// AU hosting tests against Apple's built-in Audio Units (present on every Mac, incl. CI runners).
#include <cmath>
#include <string>
#include <vector>

#include "../src/host/plugin.h"
#include "check.h"

using namespace daw3;

float runBlock(PluginInstance& p, uint32_t n, const std::vector<MidiEvt>& midi, std::vector<float>* rms);

static std::unique_ptr<PluginInstance> make(PluginFormat& f, const std::vector<PluginDesc>& all, const std::string& uid) {
  for (auto& d : all) {
    if (d.uid != uid) continue;
    std::string err;
    auto p = f.create(d, err);
    if (!p) fprintf(stderr, "  create %s failed: %s\n", uid.c_str(), err.c_str());
    return p;
  }
  fprintf(stderr, "  %s not found\n", uid.c_str());
  return nullptr;
}

void testAu() {
  auto f = makeAuFormat();
  CHECK(f != nullptr);
  if (!f) return;
  std::vector<PluginDesc> all;
  std::string err;
  CHECK(f->describe("all", all, err));
  CHECK(all.size() > 3);
  bool sawDelay = false;
  for (auto& d : all) if (d.uid == "aufx:dely:appl") { sawDelay = true; CHECK(d.vendor == "Apple"); CHECK(!d.instrument); }
  CHECK(sawDelay);

  // AUDelay: wet/dry (param 0, 0..100) at 0 = dry signal straight through
  auto delay = make(*f, all, "aufx:dely:appl");
  CHECK(delay != nullptr);
  if (delay) {
    CHECK(delay->activate(48000, 512, err));
    auto ps = delay->params();
    CHECK(ps.size() >= 3);
    bool hasMix = false;
    for (auto& p : ps) if (p.id == 0) { hasMix = true; CHECK(p.max == 100); }
    CHECK(hasMix);
    delay->setParam(0, 0);
    CHECK_NEAR(delay->getParam(0), 0, 1e-4);
    for (int i = 0; i < 3; i++) runBlock(*delay, 256, {}, nullptr);
    CHECK_NEAR(runBlock(*delay, 256, {}, nullptr), 0.5f, 1e-3);
    // state round trip into a second instance
    delay->setParam(0, 37);
    std::vector<uint8_t> st;
    CHECK(delay->getState(st));
    CHECK(st.size() > 10);
    auto other = make(*f, all, "aufx:dely:appl");
    if (other) {
      CHECK(other->activate(48000, 512, err));
      CHECK_NEAR(other->getParam(0), 50, 1e-3);
      CHECK(other->setState(base64Decode(base64Encode(st))));
      CHECK_NEAR(other->getParam(0), 37, 1e-3);
    }
    CHECK(delay->latency() == 0);
    CHECK(delay->hasEditor());
  }

  // DLSMusicDevice (General MIDI synth): silent, then sound after a note-on
  auto dls = make(*f, all, "aumu:dls :appl");
  CHECK(dls != nullptr);
  if (dls) {
    CHECK(dls->activate(48000, 512, err));
    std::vector<float> rms;
    runBlock(*dls, 512, {}, &rms);
    runBlock(*dls, 512, {{0, {0x90, 60, 110}}}, &rms);
    for (int i = 0; i < 8; i++) runBlock(*dls, 512, {}, &rms);
    float peak = 0;
    for (size_t i = 1; i < rms.size(); i++) peak = std::max(peak, rms[i]);
    CHECK(rms[0] < 1e-4);
    CHECK(peak > 1e-3);
  }
}
