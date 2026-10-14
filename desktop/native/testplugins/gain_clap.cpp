// Test CLAP plugins built in CI (MIT, part of daW³'s native test suite):
//   daw3.test.gain  — stereo gain effect: param 1 "Gain" (0..2), reports 64 samples latency, state = the gain
//   daw3.test.tone  — instrument: a sine at the last held MIDI note (CLAP note events or MIDI)
#include <clap/clap.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

const char* kGainFeatures[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_UTILITY, CLAP_PLUGIN_FEATURE_STEREO, nullptr};
const char* kToneFeatures[] = {CLAP_PLUGIN_FEATURE_INSTRUMENT, CLAP_PLUGIN_FEATURE_SYNTHESIZER, CLAP_PLUGIN_FEATURE_STEREO, nullptr};

const clap_plugin_descriptor_t kGainDesc = {CLAP_VERSION, "daw3.test.gain", "daW3 Test Gain", "daW3", "https://github.com/Coral-coder/daw3", "", "", "1.0.0", "Gain for host tests", kGainFeatures};
const clap_plugin_descriptor_t kToneDesc = {CLAP_VERSION, "daw3.test.tone", "daW3 Test Tone", "daW3", "https://github.com/Coral-coder/daw3", "", "", "1.0.0", "Sine for host tests", kToneFeatures};

struct Plug {
  clap_plugin_t plugin;
  const clap_host_t* host;
  bool instrument;
  double gain = 1.0;
  double sr = 48000;
  int note = -1;
  double phase = 0;
};

Plug* P(const clap_plugin_t* p) { return static_cast<Plug*>(p->plugin_data); }

// ---- audio ports
uint32_t portsCount(const clap_plugin_t* p, bool isInput) { return isInput && P(p)->instrument ? 0 : 1; }
bool portsGet(const clap_plugin_t*, uint32_t index, bool isInput, clap_audio_port_info_t* info) {
  if (index) return false;
  std::memset(info, 0, sizeof *info);
  info->id = isInput ? 0 : 1;
  std::strcpy(info->name, isInput ? "In" : "Out");
  info->flags = CLAP_AUDIO_PORT_IS_MAIN;
  info->channel_count = 2;
  info->port_type = CLAP_PORT_STEREO;
  info->in_place_pair = CLAP_INVALID_ID;
  return true;
}
const clap_plugin_audio_ports_t kPorts = {portsCount, portsGet};

// ---- note ports (instrument)
uint32_t notesCount(const clap_plugin_t* p, bool isInput) { return isInput && P(p)->instrument ? 1 : 0; }
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
uint32_t latencyGet(const clap_plugin_t* p) { return P(p)->instrument ? 0 : 64; }
const clap_plugin_latency_t kLatency = {latencyGet};

// ---- plugin
bool pInit(const clap_plugin_t*) { return true; }
void pDestroy(const clap_plugin_t* p) { delete P(p); }
bool pActivate(const clap_plugin_t* p, double sr, uint32_t, uint32_t) { P(p)->sr = sr; return true; }
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
  float** in = s->instrument ? nullptr : proc->audio_inputs[0].data32;
  for (uint32_t i = 0; i < n; i++) {
    // sample-accurate events
    while (ei < ne) {
      const clap_event_header_t* e = proc->in_events->get(proc->in_events, ei);
      if (e->time > i) break;
      applyEvent(s, e);
      ei++;
    }
    if (s->instrument) {
      float v = 0;
      if (s->note >= 0) {
        v = (float)(0.25 * s->gain * std::sin(s->phase));
        s->phase += 2 * M_PI * 440.0 * std::pow(2.0, (s->note - 69) / 12.0) / s->sr;
      }
      out[0][i] = v;
      out[1][i] = v;
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
  if (!std::strcmp(id, CLAP_EXT_NOTE_PORTS) && P(p)->instrument) return &kNotes;
  return nullptr;
}
void pMain(const clap_plugin_t*) {}

const clap_plugin_t* create(const clap_host_t* host, bool instrument) {
  Plug* s = new Plug();
  s->host = host;
  s->instrument = instrument;
  s->plugin = {instrument ? &kToneDesc : &kGainDesc, s, pInit, pDestroy, pActivate, pDeactivate, pStart, pStop, pReset, pProcess, pExt, pMain};
  return &s->plugin;
}

uint32_t fCount(const clap_plugin_factory_t*) { return 2; }
const clap_plugin_descriptor_t* fDesc(const clap_plugin_factory_t*, uint32_t i) { return i == 0 ? &kGainDesc : i == 1 ? &kToneDesc : nullptr; }
const clap_plugin_t* fCreate(const clap_plugin_factory_t*, const clap_host_t* host, const char* id) {
  if (!std::strcmp(id, kGainDesc.id)) return create(host, false);
  if (!std::strcmp(id, kToneDesc.id)) return create(host, true);
  return nullptr;
}
const clap_plugin_factory_t kFactory = {fCount, fDesc, fCreate};

bool eInit(const char*) { return true; }
void eDeinit() {}
const void* eFactory(const char* id) { return !std::strcmp(id, CLAP_PLUGIN_FACTORY_ID) ? &kFactory : nullptr; }

}  // namespace

extern "C" CLAP_EXPORT const clap_plugin_entry_t clap_entry = {CLAP_VERSION, eInit, eDeinit, eFactory};
