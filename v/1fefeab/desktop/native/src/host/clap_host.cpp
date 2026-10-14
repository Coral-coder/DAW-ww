// CLAP hosting (MIT-licensed headers from free-audio/clap 1.2.7).

#include <algorithm>
#include <atomic>
#include <cstring>
#include <map>
#include <thread>
#include <tuple>

#include "clap/clap.h"
#include "platform.h"
#include "plugin.h"

namespace daw3 {
namespace {

struct ClapModule {
  void* handle = nullptr;
  const clap_plugin_entry_t* entry = nullptr;
  const clap_plugin_factory_t* factory = nullptr;
};

std::mutex gModMutex;
std::map<std::string, ClapModule> gModules;

const ClapModule* loadModule(const std::string& path, std::string& err) {
  std::lock_guard<std::mutex> g(gModMutex);
  auto it = gModules.find(path);
  if (it != gModules.end()) return &it->second;
  const std::string bin = bundleBinary(path, ".clap");
  if (bin.empty()) { err = "No binary inside " + path; return nullptr; }
  void* h = dlOpen(bin, err);
  if (!h) return nullptr;
  auto* entry = (const clap_plugin_entry_t*)dlSym(h, "clap_entry");
  if (!entry) { err = "Not a CLAP plugin (no clap_entry)"; dlClose(h); return nullptr; }
  if (!clap_version_is_compatible(entry->clap_version)) { err = "Incompatible CLAP version"; dlClose(h); return nullptr; }
  if (!entry->init(path.c_str())) { err = "clap_entry.init failed"; dlClose(h); return nullptr; }
  auto* f = (const clap_plugin_factory_t*)entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
  if (!f) { err = "CLAP module has no plugin factory"; entry->deinit(); dlClose(h); return nullptr; }
  ClapModule m{h, entry, f};
  return &(gModules[path] = m);
}

bool hasFeature(const clap_plugin_descriptor_t* d, const char* f) {
  if (!d->features) return false;
  for (const char* const* p = d->features; *p; ++p) if (!strcmp(*p, f)) return true;
  return false;
}

thread_local bool tAudioThread = false;

// ------------------------------------------------------------------------------------- events
union AnyEvent {
  clap_event_header_t header;
  clap_event_note_t note;
  clap_event_midi_t midi;
  clap_event_param_value_t param;
};

struct EventList {
  std::vector<AnyEvent> store;
  std::vector<const clap_event_header_t*> order;
  clap_input_events_t in{};
  EventList() {
    store.reserve(2048);
    order.reserve(2048);
    in.ctx = this;
    in.size = [](const clap_input_events_t* l) -> uint32_t { return (uint32_t)static_cast<EventList*>(l->ctx)->order.size(); };
    in.get = [](const clap_input_events_t* l, uint32_t i) -> const clap_event_header_t* {
      auto* s = static_cast<EventList*>(l->ctx);
      return i < s->order.size() ? s->order[i] : nullptr;
    };
  }
  void clear() { store.clear(); order.clear(); }
  AnyEvent* add() {
    if (store.size() == store.capacity()) return nullptr;  // never reallocate on the audio thread
    store.emplace_back();
    std::memset(&store.back(), 0, sizeof(AnyEvent));
    return &store.back();
  }
  void finish() {
    for (auto& e : store) order.push_back(&e.header);
    std::stable_sort(order.begin(), order.end(), [](auto a, auto b) { return a->time < b->time; });
  }
};

class ClapInstance;

struct OutEvents {
  clap_output_events_t out{};
  ClapInstance* inst = nullptr;
  std::vector<ParamEvt>* sink = nullptr;
};

// ------------------------------------------------------------------------------------- instance
class ClapInstance : public PluginInstance {
 public:
  ClapInstance(const PluginDesc& d) : desc_(d) {
    host_.clap_version = CLAP_VERSION;
    host_.host_data = this;
    host_.name = "daW3";
    host_.vendor = "Coral-coder";
    host_.url = "https://github.com/Coral-coder/daw3";
    host_.version = "1.0.0";
    host_.get_extension = [](const clap_host_t* h, const char* id) -> const void* { return self(h)->hostExtension(id); };
    host_.request_restart = [](const clap_host_t* h) { self(h)->restartRequested_ = true; };
    host_.request_process = [](const clap_host_t*) {};
    host_.request_callback = [](const clap_host_t* h) {
      ClapInstance* s = self(h);
      runOnMain([s, alive = s->alive_]() { if (*alive && s->plugin_) s->plugin_->on_main_thread(s->plugin_); });
    };
    hParams_.rescan = [](const clap_host_t* h, clap_param_rescan_flags) { auto l = self(h)->listener(); if (l.paramsRescanned) l.paramsRescanned(); };
    hParams_.clear = [](const clap_host_t*, clap_id, clap_param_clear_flags) {};
    hParams_.request_flush = [](const clap_host_t*) {};
    hLatency_.changed = [](const clap_host_t* h) { auto l = self(h)->listener(); if (l.latencyChanged) l.latencyChanged(); };
    hState_.mark_dirty = [](const clap_host_t*) {};
    hLog_.log = [](const clap_host_t*, clap_log_severity sev, const char* msg) { if (sev >= CLAP_LOG_WARNING) fprintf(stderr, "[clap] %s\n", msg ? msg : ""); };
    hThread_.is_main_thread = [](const clap_host_t* h) { return std::this_thread::get_id() == self(h)->mainThread_; };
    hThread_.is_audio_thread = [](const clap_host_t*) { return tAudioThread; };
    hGui_.resize_hints_changed = [](const clap_host_t*) {};
    hGui_.request_resize = [](const clap_host_t* h, uint32_t w, uint32_t hh) {
      ClapInstance* s = self(h);
      runOnMain([s, w, hh, alive = s->alive_]() { if (*alive && s->window_) guiResizeWindow(s->window_, (int)w, (int)hh); });
      return true;
    };
    hGui_.request_show = [](const clap_host_t*) { return true; };
    hGui_.request_hide = [](const clap_host_t*) { return true; };
    hGui_.closed = [](const clap_host_t* h, bool) { ClapInstance* s = self(h); runOnMain([s, alive = s->alive_]() { if (*alive) s->closeEditor(); }); };
    hPresetLoad_.on_error = [](const clap_host_t* h, uint32_t, const char*, const char*, int32_t, const char* msg) { self(h)->presetError_ = msg ? msg : "preset error"; };
    hPresetLoad_.loaded = [](const clap_host_t* h, uint32_t, const char*, const char*) { auto l = self(h)->listener(); if (l.paramsRescanned) l.paramsRescanned(); };
    outEv_.out.ctx = &outEv_;
    outEv_.inst = this;
    outEv_.out.try_push = [](const clap_output_events_t* l, const clap_event_header_t* e) -> bool {
      auto* o = static_cast<OutEvents*>(l->ctx);
      if (e->space_id == CLAP_CORE_EVENT_SPACE_ID && e->type == CLAP_EVENT_PARAM_VALUE) {
        auto* pv = reinterpret_cast<const clap_event_param_value_t*>(e);
        if (o->sink && o->sink->size() < o->sink->capacity()) o->sink->push_back({e->time, pv->param_id, pv->value});
        auto lis = o->inst->listener();
        if (lis.paramChanged && !tAudioThread) lis.paramChanged(pv->param_id, pv->value);
      }
      return true;
    };
    mainThread_ = std::this_thread::get_id();
  }

  ~ClapInstance() override {
    *alive_ = false;
    closeEditor();
    if (plugin_) {
      deactivate();
      plugin_->destroy(plugin_);
    }
  }

  bool init(const ClapModule* mod, std::string& err) {
    mod_ = mod;
    const clap_plugin_factory_t* f = mod->factory;
    plugin_ = f->create_plugin(f, &host_, desc_.uid.c_str());
    if (!plugin_) { err = "create_plugin failed"; return false; }
    if (!plugin_->init(plugin_)) { err = "plugin init failed"; plugin_->destroy(plugin_); plugin_ = nullptr; return false; }
    params_ = (const clap_plugin_params_t*)plugin_->get_extension(plugin_, CLAP_EXT_PARAMS);
    state_ = (const clap_plugin_state_t*)plugin_->get_extension(plugin_, CLAP_EXT_STATE);
    latency_ = (const clap_plugin_latency_t*)plugin_->get_extension(plugin_, CLAP_EXT_LATENCY);
    tail_ = (const clap_plugin_tail_t*)plugin_->get_extension(plugin_, CLAP_EXT_TAIL);
    gui_ = (const clap_plugin_gui_t*)plugin_->get_extension(plugin_, CLAP_EXT_GUI);
    render_ = (const clap_plugin_render_t*)plugin_->get_extension(plugin_, CLAP_EXT_RENDER);
    readPorts();
    auto* notes = (const clap_plugin_note_ports_t*)plugin_->get_extension(plugin_, CLAP_EXT_NOTE_PORTS);
    if (notes && notes->count(plugin_, true) > 0) {
      clap_note_port_info_t ni;
      if (notes->get(plugin_, 0, true, &ni)) {
        desc_.midiInput = true;
        noteDialect_ = ni.preferred_dialect == CLAP_NOTE_DIALECT_MIDI || !(ni.supported_dialects & CLAP_NOTE_DIALECT_CLAP) ? CLAP_NOTE_DIALECT_MIDI : CLAP_NOTE_DIALECT_CLAP;
        midiOk_ = (ni.supported_dialects & CLAP_NOTE_DIALECT_MIDI) != 0;
      }
    }
    return true;
  }

  /** Audio ports -> main input, sidechain (first non-main input port), every output port. */
  void readPorts() {
    inCh_.clear();
    outCh_.clear();
    mainIn_ = scIn_ = -1;
    desc_.numInputs = desc_.numOutputs = 0;
    desc_.sidechainChannels = 0;
    desc_.outputBuses.clear();
    auto* ports = (const clap_plugin_audio_ports_t*)plugin_->get_extension(plugin_, CLAP_EXT_AUDIO_PORTS);
    if (!ports) return;
    clap_audio_port_info_t info;
    const uint32_t ni = std::min<uint32_t>(ports->count(plugin_, true), 8);
    for (uint32_t i = 0; i < ni; i++) {
      if (!ports->get(plugin_, i, true, &info)) { inCh_.push_back(0); continue; }
      inCh_.push_back(std::min<uint32_t>(info.channel_count, 8));
      if (mainIn_ < 0 && (info.flags & CLAP_AUDIO_PORT_IS_MAIN)) mainIn_ = (int)i;
    }
    if (mainIn_ < 0 && ni > 0) mainIn_ = 0;
    for (uint32_t i = 0; i < ni; i++) if ((int)i != mainIn_ && inCh_[i] > 0) { scIn_ = (int)i; break; }
    if (mainIn_ >= 0) desc_.numInputs = (int)inCh_[mainIn_];
    if (scIn_ >= 0) desc_.sidechainChannels = (int)inCh_[scIn_];
    const uint32_t no = std::min<uint32_t>(ports->count(plugin_, false), 16);
    for (uint32_t i = 0; i < no; i++) {
      AudioBus bus;
      bus.channels = 0;
      if (ports->get(plugin_, i, false, &info)) {
        bus.channels = (int)std::min<uint32_t>(info.channel_count, 8);
        bus.name = info.name;
      }
      if (bus.name.empty()) bus.name = i == 0 ? "Main" : "Out " + std::to_string(i + 1);
      outCh_.push_back((uint32_t)bus.channels);
      desc_.outputBuses.push_back(bus);
    }
    if (!outCh_.empty()) desc_.numOutputs = (int)outCh_[0];
  }

  const PluginDesc& desc() const override { return desc_; }

  bool activate(double sr, uint32_t maxFrames, std::string& err) override {
    if (active_) deactivate();
    if (!plugin_->activate(plugin_, sr, 1, maxFrames)) { err = "plugin activate failed"; return false; }
    active_ = true;
    startedProcessing_ = false;
    sr_ = sr;
    maxFrames_ = maxFrames;
    inPtrs_.assign(inCh_.size(), {});
    for (size_t i = 0; i < inCh_.size(); i++) inPtrs_[i].assign(std::max<uint32_t>(1, inCh_[i]), nullptr);
    outPtrs_.assign(outCh_.size(), {});
    for (size_t i = 0; i < outCh_.size(); i++) outPtrs_[i].assign(std::max<uint32_t>(1, outCh_[i]), nullptr);
    inBufs_.assign(inCh_.size(), clap_audio_buffer_t{});
    outBufs_.assign(outCh_.size(), clap_audio_buffer_t{});
    silence_.assign(maxFrames, 0.f);
    scratch_.assign((size_t)maxFrames * std::max(1, desc_.totalOutputs()), 0.f);
    return true;
  }

  void deactivate() override {
    if (!active_) return;
    // stop_processing belongs on the audio thread; the host's audio thread is idle while commands run
    if (startedProcessing_) { tAudioThread = true; plugin_->stop_processing(plugin_); tAudioThread = false; startedProcessing_ = false; }
    plugin_->deactivate(plugin_);
    active_ = false;
  }

  void process(ProcessBlock& b) override {
    for (uint32_t c = 0; c < b.numOut; c++) std::memset(b.out[c], 0, sizeof(float) * b.nframes);
    if (!active_) return;
    tAudioThread = true;
    if (!startedProcessing_) startedProcessing_ = plugin_->start_processing(plugin_);
    events_.clear();
    {
      std::unique_lock<std::mutex> l(pendingM_, std::try_to_lock);
      if (l.owns_lock()) {
        for (auto& p : pending_) addParam(0, p.first, p.second);
        pending_.clear();
      }
    }
    for (uint32_t i = 0; i < b.paramCount; i++) addParam(std::min(b.params[i].offset, b.nframes - 1), b.params[i].id, b.params[i].value);
    for (uint32_t i = 0; i < b.midiCount; i++) addMidi(b.midi[i], b.nframes);
    events_.finish();

    clap_event_transport_t tr{};
    tr.header.size = sizeof tr;
    tr.header.type = CLAP_EVENT_TRANSPORT;
    tr.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
    tr.flags = CLAP_TRANSPORT_HAS_TEMPO | CLAP_TRANSPORT_HAS_BEATS_TIMELINE | (b.playing ? CLAP_TRANSPORT_IS_PLAYING : 0);
    tr.tempo = b.tempo;
    tr.song_pos_beats = (clap_beattime)llround(b.ppqPos * (double)CLAP_BEATTIME_FACTOR);

    // channel pointers: the main port reads the block's input, the sidechain port its key (missing channels
    // repeat the last one / read silence); outputs map bus after bus onto b.out, the rest goes to scratch
    for (size_t i = 0; i < inCh_.size(); i++) {
      const float* const* src = (int)i == mainIn_ ? b.in : (int)i == scIn_ ? b.sc : nullptr;
      const uint32_t n = (int)i == mainIn_ ? b.numIn : (int)i == scIn_ ? b.numSc : 0;
      for (uint32_t c = 0; c < inCh_[i]; c++) inPtrs_[i][c] = const_cast<float*>(src && n ? src[std::min(c, n - 1)] : silence_.data());
      inBufs_[i] = clap_audio_buffer_t{};
      inBufs_[i].data32 = inPtrs_[i].data();
      inBufs_[i].channel_count = inCh_[i];
    }
    uint32_t oc = 0;
    for (size_t i = 0; i < outCh_.size(); i++) {
      for (uint32_t c = 0; c < outCh_[i]; c++, oc++) outPtrs_[i][c] = oc < b.numOut ? b.out[oc] : scratch_.data() + (size_t)oc * maxFrames_;
      outBufs_[i] = clap_audio_buffer_t{};
      outBufs_[i].data32 = outPtrs_[i].data();
      outBufs_[i].channel_count = outCh_[i];
    }
    clap_process_t p{};
    p.steady_time = (int64_t)steady_;
    p.frames_count = b.nframes;
    p.transport = &tr;
    p.audio_inputs = inBufs_.empty() ? nullptr : inBufs_.data();
    p.audio_inputs_count = (uint32_t)inBufs_.size();
    p.audio_outputs = outBufs_.empty() ? nullptr : outBufs_.data();
    p.audio_outputs_count = (uint32_t)outBufs_.size();
    p.in_events = &events_.in;
    outEv_.sink = b.outParams;
    p.out_events = &outEv_.out;
    plugin_->process(plugin_, &p);
    // a mono plugin feeds both sides of a stereo bus
    if (outCh_.size() == 1 && outCh_[0] == 1 && b.numOut > 1) std::memcpy(b.out[1], b.out[0], sizeof(float) * b.nframes);
    steady_ += b.nframes;
    tAudioThread = false;
  }

  std::vector<ParamInfo> params() override {
    std::vector<ParamInfo> out;
    if (!params_) return out;
    const uint32_t n = params_->count(plugin_);
    for (uint32_t i = 0; i < n; i++) {
      clap_param_info_t pi;
      if (!params_->get_info(plugin_, i, &pi)) continue;
      ParamInfo p;
      p.id = pi.id;
      p.name = pi.name;
      p.module = pi.module;
      p.min = pi.min_value;
      p.max = pi.max_value;
      p.def = pi.default_value;
      p.flags = 0;
      if (pi.flags & CLAP_PARAM_IS_AUTOMATABLE) p.flags |= kParamAutomatable;
      if (pi.flags & CLAP_PARAM_IS_STEPPED) { p.flags |= kParamStepped; p.steps = (int)std::max(1.0, pi.max_value - pi.min_value); }
      if (pi.flags & CLAP_PARAM_IS_HIDDEN) p.flags |= kParamHidden;
      if (pi.flags & CLAP_PARAM_IS_READONLY) p.flags |= kParamReadOnly;
      if (pi.flags & CLAP_PARAM_IS_BYPASS) p.flags |= kParamBypass;
      out.push_back(p);
    }
    return out;
  }

  double getParam(uint32_t id) override {
    double v = 0;
    if (params_ && params_->get_value(plugin_, id, &v)) return v;
    return 0;
  }

  void setParam(uint32_t id, double value) override {
    if (!active_ && params_) {
      // not processing: flush the change straight into the plugin
      events_.clear();
      addParam(0, id, value);
      events_.finish();
      outEv_.sink = nullptr;
      params_->flush(plugin_, &events_.in, &outEv_.out);
      return;
    }
    std::lock_guard<std::mutex> g(pendingM_);
    pending_.emplace_back(id, value);
  }

  bool getState(std::vector<uint8_t>& out) override {
    if (!state_) return false;
    out.clear();
    clap_ostream_t os{&out, [](const clap_ostream_t* s, const void* buf, uint64_t size) -> int64_t {
      auto* v = static_cast<std::vector<uint8_t>*>(s->ctx);
      v->insert(v->end(), (const uint8_t*)buf, (const uint8_t*)buf + size);
      return (int64_t)size;
    }};
    return state_->save(plugin_, &os);
  }

  bool setState(const std::vector<uint8_t>& in) override {
    if (!state_) return false;
    struct Rd { const std::vector<uint8_t>* v; size_t pos; } rd{&in, 0};
    clap_istream_t is{&rd, [](const clap_istream_t* s, void* buf, uint64_t size) -> int64_t {
      auto* r = static_cast<Rd*>(s->ctx);
      size_t n = (size_t)std::min<uint64_t>(size, r->v->size() - r->pos);
      std::memcpy(buf, r->v->data() + r->pos, n);
      r->pos += n;
      return (int64_t)n;
    }};
    return state_->load(plugin_, &is);
  }

  uint32_t latency() override { return latency_ ? latency_->get(plugin_) : 0; }
  uint32_t tailSamples() override { return tail_ ? tail_->get(plugin_) : 0; }
  bool supportsOffline() override { return !(render_ && render_->has_hard_realtime_requirement(plugin_)); }
  void setOffline(bool off) override { if (render_) render_->set(plugin_, off ? CLAP_RENDER_OFFLINE : CLAP_RENDER_REALTIME); }

  // ---- presets: the preset-discovery factory of the module + the plugin's preset-load extension
  std::vector<PresetInfo> presets() override {
    std::vector<PresetInfo> out;
    if (!mod_ || !mod_->entry) return out;
    auto* pf = (const clap_preset_discovery_factory_t*)mod_->entry->get_factory(CLAP_PRESET_DISCOVERY_FACTORY_ID);
    if (!pf) pf = (const clap_preset_discovery_factory_t*)mod_->entry->get_factory(CLAP_PRESET_DISCOVERY_FACTORY_ID_COMPAT);
    if (!pf) return out;
    struct Decl {
      std::vector<std::string> exts;
      std::vector<std::tuple<uint32_t, std::string, std::string, uint32_t>> locs;  // kind, location, name, flags
    } decl;
    clap_preset_discovery_indexer_t ix{};
    ix.clap_version = CLAP_VERSION;
    ix.name = "daW3";
    ix.vendor = "Coral-coder";
    ix.indexer_data = &decl;
    ix.declare_filetype = [](const clap_preset_discovery_indexer_t* i, const clap_preset_discovery_filetype_t* ft) {
      if (ft) static_cast<Decl*>(i->indexer_data)->exts.push_back(ft->file_extension ? ft->file_extension : "");
      return true;
    };
    ix.declare_location = [](const clap_preset_discovery_indexer_t* i, const clap_preset_discovery_location_t* l) {
      if (l) static_cast<Decl*>(i->indexer_data)->locs.emplace_back(l->kind, l->location ? l->location : "", l->name ? l->name : "", l->flags);
      return true;
    };
    ix.declare_soundpack = [](const clap_preset_discovery_indexer_t*, const clap_preset_discovery_soundpack_t*) { return true; };
    ix.get_extension = [](const clap_preset_discovery_indexer_t*, const char*) -> const void* { return nullptr; };

    struct Found { std::string name, key; bool ours = false, anyId = false; };
    struct Recv { std::vector<Found> list; std::string uid; } rc;
    rc.uid = desc_.uid;
    clap_preset_discovery_metadata_receiver_t mr{};
    mr.receiver_data = &rc;
    mr.on_error = [](const clap_preset_discovery_metadata_receiver_t*, int32_t, const char* msg) { if (msg) fprintf(stderr, "[clap presets] %s\n", msg); };
    mr.begin_preset = [](const clap_preset_discovery_metadata_receiver_t* r, const char* name, const char* key) {
      auto* s = static_cast<Recv*>(r->receiver_data);
      s->list.push_back({name ? name : "", key ? key : ""});
      return s->list.size() < 4000;
    };
    mr.add_plugin_id = [](const clap_preset_discovery_metadata_receiver_t* r, const clap_universal_plugin_id_t* id) {
      auto* s = static_cast<Recv*>(r->receiver_data);
      if (s->list.empty() || !id) return;
      s->list.back().anyId = true;
      if (id->abi && id->id && !strcmp(id->abi, "clap") && s->uid == id->id) s->list.back().ours = true;
    };
    mr.set_soundpack_id = [](const clap_preset_discovery_metadata_receiver_t*, const char*) {};
    mr.set_flags = [](const clap_preset_discovery_metadata_receiver_t*, uint32_t) {};
    mr.add_creator = [](const clap_preset_discovery_metadata_receiver_t*, const char*) {};
    mr.set_description = [](const clap_preset_discovery_metadata_receiver_t*, const char*) {};
    mr.set_timestamps = [](const clap_preset_discovery_metadata_receiver_t*, clap_timestamp, clap_timestamp) {};
    mr.add_feature = [](const clap_preset_discovery_metadata_receiver_t*, const char*) {};
    mr.add_extra_info = [](const clap_preset_discovery_metadata_receiver_t*, const char*, const char*) {};

    const uint32_t np = pf->count(pf);
    for (uint32_t pi = 0; pi < np && pi < 16; pi++) {
      const clap_preset_discovery_provider_descriptor_t* pd = pf->get_descriptor(pf, pi);
      if (!pd || !pd->id) continue;
      decl = Decl{};
      const clap_preset_discovery_provider_t* prov = pf->create(pf, &ix, pd->id);
      if (!prov) continue;
      if (prov->init(prov)) {
        auto collect = [&](uint32_t kind, const std::string& loc, const std::string& category) {
          rc.list.clear();
          if (!prov->get_metadata(prov, kind, kind == CLAP_PRESET_DISCOVERY_LOCATION_PLUGIN ? nullptr : loc.c_str(), &mr)) return;
          for (auto& f : rc.list) {
            if (f.anyId && !f.ours) continue;  // a preset of another plugin of this provider
            PresetInfo p;
            p.kind = kind == CLAP_PRESET_DISCOVERY_LOCATION_PLUGIN ? "factory" : "file";
            p.path = kind == CLAP_PRESET_DISCOVERY_LOCATION_PLUGIN ? "" : loc;
            p.name = !f.name.empty() ? f.name : stripExt(baseName(loc));
            p.category = category;
            p.id = std::to_string(kind) + "\x1f" + loc + "\x1f" + f.key;
            out.push_back(p);
          }
        };
        for (auto& [kind, loc, name, flags] : decl.locs) {
          if (kind == CLAP_PRESET_DISCOVERY_LOCATION_PLUGIN) { collect(kind, "", name); continue; }
          if (!isDirectory(loc)) { if (!loc.empty()) collect(kind, loc, name); continue; }
          std::vector<std::pair<std::string, std::string>> files;
          for (auto& ext : decl.exts) {
            auto f = findPresetFiles({loc}, ext.empty() ? "" : (ext[0] == '.' ? ext : "." + ext));
            files.insert(files.end(), f.begin(), f.end());
          }
          for (auto& [path, cat] : files) collect(kind, path, cat.empty() ? name : cat);
        }
      }
      prov->destroy(prov);
    }
    return out;
  }

  bool loadPreset(const std::string& id, std::string& err) override {
    const size_t a = id.find('\x1f'), b = a == std::string::npos ? a : id.find('\x1f', a + 1);
    if (b == std::string::npos) { err = "Bad preset id"; return false; }
    const uint32_t kind = (uint32_t)atoi(id.substr(0, a).c_str());
    const std::string loc = id.substr(a + 1, b - a - 1), key = id.substr(b + 1);
    auto* pl = (const clap_plugin_preset_load_t*)plugin_->get_extension(plugin_, CLAP_EXT_PRESET_LOAD);
    if (!pl) pl = (const clap_plugin_preset_load_t*)plugin_->get_extension(plugin_, CLAP_EXT_PRESET_LOAD_COMPAT);
    if (!pl) { err = "This plugin cannot load presets"; return false; }
    presetError_.clear();
    if (!pl->from_location(plugin_, kind, kind == CLAP_PRESET_DISCOVERY_LOCATION_PLUGIN ? nullptr : loc.c_str(), key.empty() ? nullptr : key.c_str())) {
      err = presetError_.empty() ? "The plugin could not load the preset" : presetError_;
      return false;
    }
    return true;
  }

  bool hasEditor() override {
#ifdef __APPLE__
    return gui_ && gui_->is_api_supported(plugin_, CLAP_WINDOW_API_COCOA, false);
#else
    return false;
#endif
  }

  bool openEditor(std::string& err) override {
#ifdef __APPLE__
    if (window_) return true;
    if (!hasEditor()) { err = "This plugin has no editor"; return false; }
    if (!gui_->create(plugin_, CLAP_WINDOW_API_COCOA, false)) { err = "The plugin could not create its editor"; return false; }
    uint32_t w = 600, h = 400;
    gui_->get_size(plugin_, &w, &h);
    const bool resizable = gui_->can_resize && gui_->can_resize(plugin_);
    window_ = guiCreateWindow(desc_.name, (int)w, (int)h, resizable, [this, alive = alive_]() {
      if (!*alive) return;
      window_ = nullptr;
      if (guiCreated_) { gui_->hide(plugin_); gui_->destroy(plugin_); guiCreated_ = false; }
      auto l = listener();
      if (l.editorClosed) l.editorClosed();
    });
    guiCreated_ = true;
    clap_window_t win{};
    win.api = CLAP_WINDOW_API_COCOA;
    win.cocoa = guiWindowView(window_);
    gui_->set_parent(plugin_, &win);
    gui_->show(plugin_);
    return true;
#else
    err = "Plugin editors are only available on macOS";
    return false;
#endif
  }

  void closeEditor() override {
    if (guiCreated_) { gui_->hide(plugin_); gui_->destroy(plugin_); guiCreated_ = false; }
    if (window_) { void* w = window_; window_ = nullptr; guiCloseWindow(w); }
  }

 private:
  static ClapInstance* self(const clap_host_t* h) { return static_cast<ClapInstance*>(h->host_data); }

  const void* hostExtension(const char* id) {
    if (!strcmp(id, CLAP_EXT_PARAMS)) return &hParams_;
    if (!strcmp(id, CLAP_EXT_LATENCY)) return &hLatency_;
    if (!strcmp(id, CLAP_EXT_STATE)) return &hState_;
    if (!strcmp(id, CLAP_EXT_LOG)) return &hLog_;
    if (!strcmp(id, CLAP_EXT_THREAD_CHECK)) return &hThread_;
    if (!strcmp(id, CLAP_EXT_GUI)) return &hGui_;
    if (!strcmp(id, CLAP_EXT_PRESET_LOAD) || !strcmp(id, CLAP_EXT_PRESET_LOAD_COMPAT)) return &hPresetLoad_;
    return nullptr;
  }

  void addParam(uint32_t t, uint32_t id, double v) {
    AnyEvent* e = events_.add();
    if (!e) return;
    e->param.header = {sizeof(clap_event_param_value_t), t, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE, 0};
    e->param.param_id = id;
    e->param.cookie = nullptr;
    e->param.note_id = -1;
    e->param.port_index = -1;
    e->param.channel = -1;
    e->param.key = -1;
    e->param.value = v;
  }

  void addMidi(const MidiEvt& m, uint32_t nframes) {
    const uint32_t t = std::min(m.offset, nframes ? nframes - 1 : 0);
    const uint8_t st = m.data[0] & 0xF0, ch = m.data[0] & 0x0F;
    const bool isNote = st == 0x90 || st == 0x80;
    if (isNote && noteDialect_ == CLAP_NOTE_DIALECT_CLAP) {
      AnyEvent* e = events_.add();
      if (!e) return;
      const bool on = st == 0x90 && m.data[2] > 0;
      e->note.header = {sizeof(clap_event_note_t), t, CLAP_CORE_EVENT_SPACE_ID, (uint16_t)(on ? CLAP_EVENT_NOTE_ON : CLAP_EVENT_NOTE_OFF), 0};
      e->note.note_id = -1;
      e->note.port_index = 0;
      e->note.channel = ch;
      e->note.key = m.data[1];
      e->note.velocity = m.data[2] / 127.0;
      return;
    }
    if (!midiOk_ && noteDialect_ == CLAP_NOTE_DIALECT_CLAP) return;
    AnyEvent* e = events_.add();
    if (!e) return;
    e->midi.header = {sizeof(clap_event_midi_t), t, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_MIDI, 0};
    e->midi.port_index = 0;
    std::memcpy(e->midi.data, m.data, 3);
  }

  PluginDesc desc_;
  clap_host_t host_{};
  clap_host_params_t hParams_{};
  clap_host_latency_t hLatency_{};
  clap_host_state_t hState_{};
  clap_host_log_t hLog_{};
  clap_host_thread_check_t hThread_{};
  clap_host_gui_t hGui_{};
  clap_host_preset_load_t hPresetLoad_{};
  const ClapModule* mod_ = nullptr;
  std::string presetError_;
  std::vector<uint32_t> inCh_, outCh_;
  int mainIn_ = -1, scIn_ = -1;
  std::vector<std::vector<float*>> inPtrs_, outPtrs_;
  std::vector<clap_audio_buffer_t> inBufs_, outBufs_;
  double sr_ = 48000;
  uint32_t maxFrames_ = 0;
  const clap_plugin_t* plugin_ = nullptr;
  const clap_plugin_params_t* params_ = nullptr;
  const clap_plugin_state_t* state_ = nullptr;
  const clap_plugin_latency_t* latency_ = nullptr;
  const clap_plugin_tail_t* tail_ = nullptr;
  const clap_plugin_gui_t* gui_ = nullptr;
  const clap_plugin_render_t* render_ = nullptr;
  clap_note_dialect noteDialect_ = CLAP_NOTE_DIALECT_CLAP;
  bool midiOk_ = false;
  bool active_ = false, startedProcessing_ = false, guiCreated_ = false;
  std::atomic<bool> restartRequested_{false};
  void* window_ = nullptr;
  std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
  std::thread::id mainThread_;
  EventList events_;
  OutEvents outEv_;
  std::mutex pendingM_;
  std::vector<std::pair<uint32_t, double>> pending_;
  std::vector<float> silence_, scratch_;
  uint64_t steady_ = 0;
};

// ------------------------------------------------------------------------------------- format
class ClapFormat : public PluginFormat {
 public:
  std::string name() const override { return "clap"; }
  std::string bundleExtension() const override { return ".clap"; }
  std::vector<std::string> defaultPaths() const override {
    std::vector<std::string> out;
#ifdef __APPLE__
    out = {homeDir() + "/Library/Audio/Plug-Ins/CLAP", "/Library/Audio/Plug-Ins/CLAP"};
#elif defined(_WIN32)
    // the CLAP spec's Windows locations: %LOCALAPPDATA%\Programs\Common\CLAP, %COMMONPROGRAMFILES%\CLAP
    out = {winFolder(WinFolder::LocalAppData) + "/Programs/Common/CLAP", winFolder(WinFolder::CommonProgramFiles) + "/CLAP"};
#else
    out = {homeDir() + "/.clap", "/usr/lib/clap", "/usr/local/lib/clap"};
#endif
    for (auto& p : splitPathList(envVar("CLAP_PATH"))) out.push_back(p);
    return out;
  }

  bool describe(const std::string& path, std::vector<PluginDesc>& out, std::string& err) override {
    const ClapModule* m = loadModule(path, err);
    if (!m) return false;
    const uint32_t n = m->factory->get_plugin_count(m->factory);
    for (uint32_t i = 0; i < n; i++) {
      const clap_plugin_descriptor_t* d = m->factory->get_plugin_descriptor(m->factory, i);
      if (!d || !clap_version_is_compatible(d->clap_version)) continue;
      PluginDesc pd;
      pd.format = "clap";
      pd.uid = d->id;
      pd.name = d->name ? d->name : d->id;
      pd.vendor = d->vendor ? d->vendor : "";
      pd.version = d->version ? d->version : "";
      pd.path = path;
      pd.instrument = hasFeature(d, CLAP_PLUGIN_FEATURE_INSTRUMENT);
      pd.midiInput = pd.instrument || hasFeature(d, CLAP_PLUGIN_FEATURE_NOTE_EFFECT);
      pd.numInputs = pd.instrument ? 0 : 2;
      pd.numOutputs = 2;
      const char* cats[] = {CLAP_PLUGIN_FEATURE_SYNTHESIZER, CLAP_PLUGIN_FEATURE_SAMPLER, CLAP_PLUGIN_FEATURE_DRUM, CLAP_PLUGIN_FEATURE_REVERB,
                            CLAP_PLUGIN_FEATURE_DELAY, CLAP_PLUGIN_FEATURE_EQUALIZER, CLAP_PLUGIN_FEATURE_COMPRESSOR, CLAP_PLUGIN_FEATURE_DISTORTION,
                            CLAP_PLUGIN_FEATURE_FILTER, CLAP_PLUGIN_FEATURE_CHORUS, CLAP_PLUGIN_FEATURE_UTILITY, CLAP_PLUGIN_FEATURE_ANALYZER};
      for (const char* c : cats) if (hasFeature(d, c)) { pd.category = c; break; }
      if (pd.category.empty()) pd.category = pd.instrument ? "instrument" : "audio-effect";
      out.push_back(pd);
    }
    return true;
  }

  std::unique_ptr<PluginInstance> create(const PluginDesc& d, std::string& err) override {
    const ClapModule* m = loadModule(d.path, err);
    if (!m) return nullptr;
    auto inst = std::make_unique<ClapInstance>(d);
    if (!inst->init(m, err)) return nullptr;
    return inst;
  }
};

}  // namespace

std::unique_ptr<PluginFormat> makeClapFormat() { return std::make_unique<ClapFormat>(); }

}  // namespace daw3
