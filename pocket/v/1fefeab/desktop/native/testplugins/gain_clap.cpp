// Test CLAP plugins built in CI (MIT, part of daW³'s native test suite):
//   daw3.test.gain  — stereo gain effect: param 1 "Gain" (0..2), reports 64 samples latency, state = the gain;
//                     factory presets (preset-discovery factory, location "plugin") + ".d3gain" preset files
//                     (a FILE location at $DAW3_TEST_PRESET_DIR), loaded through clap.preset-load
//   daw3.test.tone  — instrument: a sine at the last held MIDI note (CLAP note events or MIDI) on the main
//                     output port, and the same sine at half level on a second ("Aux") output port (multi-out)
//   daw3.test.duck  — stereo effect with a stereo sidechain input port: out = in * (1 - min(1, |key|))
#include <clap/clap.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace {

enum Kind { kGain, kTone, kDuck };

const char* kGainFeatures[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_UTILITY, CLAP_PLUGIN_FEATURE_STEREO, nullptr};
const char* kToneFeatures[] = {CLAP_PLUGIN_FEATURE_INSTRUMENT, CLAP_PLUGIN_FEATURE_SYNTHESIZER, CLAP_PLUGIN_FEATURE_STEREO, nullptr};
const char* kDuckFeatures[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_COMPRESSOR, CLAP_PLUGIN_FEATURE_STEREO, nullptr};

const clap_plugin_descriptor_t kGainDesc = {CLAP_VERSION, "daw3.test.gain", "daW3 Test Gain", "daW3", "https://github.com/Coral-coder/daw3", "", "", "1.0.0", "Gain for host tests", kGainFeatures};
const clap_plugin_descriptor_t kToneDesc = {CLAP_VERSION, "daw3.test.tone", "daW3 Test Tone", "daW3", "https://github.com/Coral-coder/daw3", "", "", "1.0.0", "Sine for host tests", kToneFeatures};
const clap_plugin_descriptor_t kDuckDesc = {CLAP_VERSION, "daw3.test.duck", "daW3 Test Duck", "daW3", "https://github.com/Coral-coder/daw3", "", "", "1.0.0", "Sidechain ducker for host tests", kDuckFeatures};

struct Plug {
  clap_plugin_t plugin;
  const clap_host_t* host;
  Kind kind;
  double gain = 1.0;
  double sr = 48000;
  int note = -1;
  double phase = 0;
};

Plug* P(const clap_plugin_t* p) { return static_cast<Plug*>(p->plugin_data); }

// ---- audio ports
uint32_t portsCount(const clap_plugin_t* p, bool isInput) {
  switch (P(p)->kind) {
    case kTone: return isInput ? 0 : 2;
    case kDuck: return isInput ? 2 : 1;
    default: return 1;
  }
}
bool portsGet(const clap_plugin_t* p, uint32_t index, bool isInput, clap_audio_port_info_t* info) {
  if (index >= portsCount(p, isInput)) return false;
  std::memset(info, 0, sizeof *info);
  info->id = (isInput ? 10 : 20) + index;
  const char* name = index == 0 ? (isInput ? "In" : "Out") : isInput ? "Sidechain" : "Aux";
  std::snprintf(info->name, sizeof info->name, "%s", name);
  info->flags = index == 0 ? CLAP_AUDIO_PORT_IS_MAIN : 0;
  info->channel_count = 2;
  info->port_type = CLAP_PORT_STEREO;
  info->in_place_pair = CLAP_INVALID_ID;
  return true;
}
const clap_plugin_audio_ports_t kPorts = {portsCount, portsGet};

// ---- note ports (instrument)
uint32_t notesCount(const clap_plugin_t* p, bool isInput) { return isInput && P(p)->kind == kTone ? 1 : 0; }
bool notesGet(const clap_plugin_t*, uint32_t index, bool, clap_note_port_info_t* info) {
  if (index) return false;
  std::memset(info, 0, sizeof *info);
  info->supported_dialects = CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI;
  info->preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
  std::strcpy(info->name, "Notes");
  return true;
}
const clap_plugin_note_ports_t kNotes = {notesCount, notesGet};

// ---- params
uint32_t paramsCount(const clap_plugin_t*) { return 1; }
bool paramsInfo(const clap_plugin_t*, uint32_t i, clap_param_info_t* info) {
  if (i) return false;
  std::memset(info, 0, sizeof *info);
  info->id = 1;
  info->flags = CLAP_PARAM_IS_AUTOMATABLE;
  std::strcpy(info->name, "Gain");
  std::strcpy(info->module, "Main");
  info->min_value = 0;
  info->max_value = 2;
  info->default_value = 1;
  return true;
}
bool paramsValue(const clap_plugin_t* p, clap_id id, double* v) { if (id != 1) return false; *v = P(p)->gain; return true; }
bool paramsToText(const clap_plugin_t*, clap_id, double v, char* out, uint32_t size) { snprintf(out, size, "%.2f", v); return true; }
bool paramsFromText(const clap_plugin_t*, clap_id, const char* t, double* v) { *v = atof(t); return true; }
void applyEvent(Plug* s, const clap_event_header_t* e) {
  if (e->space_id != CLAP_CORE_EVENT_SPACE_ID) return;
  if (e->type == CLAP_EVENT_PARAM_VALUE) {
    auto* pv = reinterpret_cast<const clap_event_param_value_t*>(e);
    if (pv->param_id == 1) s->gain = pv->value;
  } else if (e->type == CLAP_EVENT_NOTE_ON) {
    s->note = reinterpret_cast<const clap_event_note_t*>(e)->key;
  } else if (e->type == CLAP_EVENT_NOTE_OFF) {
    if (reinterpret_cast<const clap_event_note_t*>(e)->key == s->note) s->note = -1;
  } else if (e->type == CLAP_EVENT_MIDI) {
    auto* m = reinterpret_cast<const clap_event_midi_t*>(e);
    if ((m->data[0] & 0xF0) == 0x90 && m->data[2]) s->note = m->data[1];
    else if (((m->data[0] & 0xF0) == 0x80 || (m->data[0] & 0xF0) == 0x90) && m->data[1] == s->note) s->note = -1;
  }
}
void applyEvents(Plug* s, const clap_input_events_t* in) {
  const uint32_t n = in->size(in);
  for (uint32_t i = 0; i < n; i++) applyEvent(s, in->get(in, i));
}
void paramsFlush(const clap_plugin_t* p, const clap_input_events_t* in, const clap_output_events_t*) { applyEvents(P(p), in); }
const clap_plugin_params_t kParams = {paramsCount, paramsInfo, paramsValue, paramsToText, paramsFromText, paramsFlush};

// ---- state
bool stateSave(const clap_plugin_t* p, const clap_ostream_t* os) {
  const char magic[4] = {'D', '3', 'G', '1'};
  return os->write(os, magic, 4) == 4 && os->write(os, &P(p)->gain, sizeof(double)) == sizeof(double);
}
bool stateLoad(const clap_plugin_t* p, const clap_istream_t* is) {
  char magic[4];
  double g;
  if (is->read(is, magic, 4) != 4 || std::memcmp(magic, "D3G1", 4)) return false;
  if (is->read(is, &g, sizeof g) != sizeof g) return false;
  P(p)->gain = g;
  return true;
}
const clap_plugin_state_t kState = {stateSave, stateLoad};

// ---- latency
uint32_t latencyGet(const clap_plugin_t* p) { return P(p)->kind == kGain ? 64 : 0; }
const clap_plugin_latency_t kLatency = {latencyGet};

// ---- presets: three factory presets + ".d3gain" files (text: the gain value)
struct FactoryPreset { const char* name; const char* key; double gain; };
const FactoryPreset kFactory[] = {{"Unity", "unity", 1.0}, {"Double", "double", 2.0}, {"Half", "half", 0.5}};

bool readGainFile(const char* path, double* g) {
  FILE* f = path ? fopen(path, "rb") : nullptr;
  if (!f) return false;
  char buf[64] = {0};
  size_t n = fread(buf, 1, sizeof buf - 1, f);
  fclose(f);
  if (!n) return false;
  *g = atof(buf);
  return true;
}

bool presetLoad(const clap_plugin_t* p, uint32_t kind, const char* location, const char* key) {
  Plug* s = P(p);
  double g = -1;
  if (kind == CLAP_PRESET_DISCOVERY_LOCATION_PLUGIN) {
    for (auto& f : kFactory) if (key && !std::strcmp(key, f.key)) g = f.gain;
  } else if (!readGainFile(location, &g)) {
    g = -1;
  }
  auto* hp = (const clap_host_preset_load_t*)s->host->get_extension(s->host, CLAP_EXT_PRESET_LOAD);
  if (g < 0) {
    if (hp) hp->on_error(s->host, kind, location, key, 0, "unknown preset");
    return false;
  }
  s->gain = g;
  if (hp) hp->loaded(s->host, kind, location, key);
  return true;
}
const clap_plugin_preset_load_t kPresetLoad = {presetLoad};

// ---- plugin
bool pInit(const clap_plugin_t*) { return true; }
void pDestroy(const clap_plugin_t* p) { delete P(p); }
bool pActivate(const clap_plugin_t* p, double sr, uint32_t, uint32_t) { P(p)->sr = sr; P(p)->phase = 0; return true; }
void pDeactivate(const clap_plugin_t*) {}
bool pStart(const clap_plugin_t*) { return true; }
void pStop(const clap_plugin_t*) {}
void pReset(const clap_plugin_t*) {}
clap_process_status pProcess(const clap_plugin_t* p, const clap_process_t* proc) {
  Plug* s = P(p);
  const uint32_t n = proc->frames_count;
  const uint32_t ne = proc->in_events->size(proc->in_events);
  uint32_t ei = 0;
  float** out = proc->audio_outputs[0].data32;
  float** aux = s->kind == kTone && proc->audio_outputs_count > 1 ? proc->audio_outputs[1].data32 : nullptr;
  float** in = s->kind == kTone ? nullptr : proc->audio_inputs[0].data32;
  float** key = s->kind == kDuck && proc->audio_inputs_count > 1 ? proc->audio_inputs[1].data32 : nullptr;
  for (uint32_t i = 0; i < n; i++) {
    // sample-accurate events
    while (ei < ne) {
      const clap_event_header_t* e = proc->in_events->get(proc->in_events, ei);
      if (e->time > i) break;
      applyEvent(s, e);
      ei++;
    }
    if (s->kind == kTone) {
      float v = 0;
      if (s->note >= 0) {
        v = (float)(0.25 * s->gain * std::sin(s->phase));
        s->phase += 2 * M_PI * 440.0 * std::pow(2.0, (s->note - 69) / 12.0) / s->sr;
      }
      out[0][i] = v;
      out[1][i] = v;
      if (aux) { aux[0][i] = 0.5f * v; aux[1][i] = 0.5f * v; }
    } else if (s->kind == kDuck) {
      const float k = key ? std::fabs(key[0][i]) : 0.f;
      const float g = (float)(s->gain * (1.0 - std::fmin(1.0, k)));
      out[0][i] = in[0][i] * g;
      out[1][i] = in[1][i] * g;
    } else {
      out[0][i] = (float)(in[0][i] * s->gain);
      out[1][i] = (float)(in[1][i] * s->gain);
    }
  }
  for (; ei < ne; ei++) applyEvent(s, proc->in_events->get(proc->in_events, ei));
  return CLAP_PROCESS_CONTINUE;
}
const void* pExt(const clap_plugin_t* p, const char* id) {
  if (!std::strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &kPorts;
  if (!std::strcmp(id, CLAP_EXT_PARAMS)) return &kParams;
  if (!std::strcmp(id, CLAP_EXT_STATE)) return &kState;
  if (!std::strcmp(id, CLAP_EXT_LATENCY)) return &kLatency;
  if (!std::strcmp(id, CLAP_EXT_NOTE_PORTS) && P(p)->kind == kTone) return &kNotes;
  if (!std::strcmp(id, CLAP_EXT_PRESET_LOAD) && P(p)->kind == kGain) return &kPresetLoad;
  return nullptr;
}
void pMain(const clap_plugin_t*) {}

const clap_plugin_t* create(const clap_host_t* host, Kind kind) {
  Plug* s = new Plug();
  s->host = host;
  s->kind = kind;
  const clap_plugin_descriptor_t* d = kind == kTone ? &kToneDesc : kind == kDuck ? &kDuckDesc : &kGainDesc;
  s->plugin = {d, s, pInit, pDestroy, pActivate, pDeactivate, pStart, pStop, pReset, pProcess, pExt, pMain};
  return &s->plugin;
}

uint32_t fCount(const clap_plugin_factory_t*) { return 3; }
const clap_plugin_descriptor_t* fDesc(const clap_plugin_factory_t*, uint32_t i) { return i == 0 ? &kGainDesc : i == 1 ? &kToneDesc : i == 2 ? &kDuckDesc : nullptr; }
const clap_plugin_t* fCreate(const clap_plugin_factory_t*, const clap_host_t* host, const char* id) {
  if (!std::strcmp(id, kGainDesc.id)) return create(host, kGain);
  if (!std::strcmp(id, kToneDesc.id)) return create(host, kTone);
  if (!std::strcmp(id, kDuckDesc.id)) return create(host, kDuck);
  return nullptr;
}
const clap_plugin_factory_t kFactoryObj = {fCount, fDesc, fCreate};

// ---- preset discovery
const clap_preset_discovery_provider_descriptor_t kProviderDesc = {CLAP_VERSION, "daw3.test.presets", "daW3 test presets", "daW3"};

bool provInit(const clap_preset_discovery_provider_t* prov) {
  auto* ix = static_cast<const clap_preset_discovery_indexer_t*>(prov->provider_data);
  const clap_preset_discovery_filetype_t ft = {"daW3 gain preset", nullptr, "d3gain"};
  ix->declare_filetype(ix, &ft);
  const clap_preset_discovery_location_t factory = {CLAP_PRESET_DISCOVERY_IS_FACTORY_CONTENT, "Factory", CLAP_PRESET_DISCOVERY_LOCATION_PLUGIN, nullptr};
  ix->declare_location(ix, &factory);
  if (const char* dir = getenv("DAW3_TEST_PRESET_DIR")) {
    const clap_preset_discovery_location_t user = {CLAP_PRESET_DISCOVERY_IS_USER_CONTENT, "User", CLAP_PRESET_DISCOVERY_LOCATION_FILE, dir};
    ix->declare_location(ix, &user);
  }
  return true;
}
void provDestroy(const clap_preset_discovery_provider_t* prov) { delete prov; }
bool provMetadata(const clap_preset_discovery_provider_t*, uint32_t kind, const char* location, const clap_preset_discovery_metadata_receiver_t* r) {
  const clap_universal_plugin_id_t gain = {"clap", "daw3.test.gain"}, tone = {"clap", "daw3.test.tone"};
  if (kind == CLAP_PRESET_DISCOVERY_LOCATION_PLUGIN) {
    for (auto& f : kFactory) {
      if (!r->begin_preset(r, f.name, f.key)) return true;
      r->add_plugin_id(r, &gain);
    }
    if (r->begin_preset(r, "Tone preset", "tone")) r->add_plugin_id(r, &tone);  // not for the gain plugin
    return true;
  }
  double g;
  if (!readGainFile(location, &g)) { r->on_error(r, 0, "not a .d3gain file"); return false; }
  if (r->begin_preset(r, nullptr, nullptr)) r->add_plugin_id(r, &gain);
  return true;
}
const void* provExt(const clap_preset_discovery_provider_t*, const char*) { return nullptr; }

uint32_t pfCount(const clap_preset_discovery_factory_t*) { return 1; }
const clap_preset_discovery_provider_descriptor_t* pfDesc(const clap_preset_discovery_factory_t*, uint32_t i) { return i == 0 ? &kProviderDesc : nullptr; }
const clap_preset_discovery_provider_t* pfCreate(const clap_preset_discovery_factory_t*, const clap_preset_discovery_indexer_t* ix, const char* id) {
  if (!id || std::strcmp(id, kProviderDesc.id)) return nullptr;
  auto* p = new clap_preset_discovery_provider_t{&kProviderDesc, const_cast<clap_preset_discovery_indexer_t*>(ix), provInit, provDestroy, provMetadata, provExt};
  return p;
}
const clap_preset_discovery_factory_t kPresetFactory = {pfCount, pfDesc, pfCreate};

bool eInit(const char*) { return true; }
void eDeinit() {}
const void* eFactory(const char* id) {
  if (!std::strcmp(id, CLAP_PLUGIN_FACTORY_ID)) return &kFactoryObj;
  if (!std::strcmp(id, CLAP_PRESET_DISCOVERY_FACTORY_ID)) return &kPresetFactory;
  return nullptr;
}

}  // namespace

extern "C" CLAP_EXPORT const clap_plugin_entry_t clap_entry = {CLAP_VERSION, eInit, eDeinit, eFactory};
