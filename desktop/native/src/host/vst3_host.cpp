// VST3 hosting on the MIT-licensed VST3 pluginterfaces only (v3.8.0).
#include <dlfcn.h>

#include <algorithm>
#include <array>
#include <map>
#include <mutex>

#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "plugin.h"
#include "vst3_common.h"

#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#endif

namespace Steinberg {
DEF_CLASS_IID(IPlugView)
DEF_CLASS_IID(IPlugFrame)
namespace Vst {
DEF_CLASS_IID(IComponent)
DEF_CLASS_IID(IAudioProcessor)
DEF_CLASS_IID(IEditController)
DEF_CLASS_IID(IConnectionPoint)
DEF_CLASS_IID(IHostApplication)
DEF_CLASS_IID(IComponentHandler)
DEF_CLASS_IID(IParameterChanges)
DEF_CLASS_IID(IParamValueQueue)
DEF_CLASS_IID(IEventList)
DEF_CLASS_IID(IMessage)
DEF_CLASS_IID(IAttributeList)
DEF_CLASS_IID(IMidiMapping)
}  // namespace Vst
}  // namespace Steinberg

namespace daw3 {
namespace {

using namespace Steinberg;
using namespace Steinberg::Vst;
using v3::Query;

// ------------------------------------------------------------------------------------- module
struct Vst3Module {
  void* handle = nullptr;
  IPluginFactory* factory = nullptr;
#ifdef __APPLE__
  CFBundleRef bundle = nullptr;
#endif
};
std::mutex gModM;
std::map<std::string, Vst3Module> gMods;

const Vst3Module* loadModule(const std::string& path, std::string& err) {
  std::lock_guard<std::mutex> g(gModM);
  auto it = gMods.find(path);
  if (it != gMods.end()) return &it->second;
  Vst3Module m;
  using GetFactory = IPluginFactory* (*)();
#ifdef __APPLE__
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(nullptr, (const UInt8*)path.c_str(), (CFIndex)path.size(), true);
  m.bundle = url ? CFBundleCreate(nullptr, url) : nullptr;
  if (url) CFRelease(url);
  if (!m.bundle) { err = "Not a bundle: " + path; return nullptr; }
  CFErrorRef cfErr = nullptr;
  if (!CFBundleLoadExecutableAndReturnError(m.bundle, &cfErr)) {
    err = "Could not load the VST3 binary (wrong architecture?)";
    if (cfErr) CFRelease(cfErr);
    CFRelease(m.bundle);
    return nullptr;
  }
  using BundleEntry = bool (*)(CFBundleRef);
  auto entry = (BundleEntry)CFBundleGetFunctionPointerForName(m.bundle, CFSTR("bundleEntry"));
  if (entry && !entry(m.bundle)) { err = "bundleEntry failed"; return nullptr; }
  auto gf = (GetFactory)CFBundleGetFunctionPointerForName(m.bundle, CFSTR("GetPluginFactory"));
#else
  const std::string bin = bundleBinary(path, ".vst3");
  m.handle = bin.empty() ? nullptr : dlopen(bin.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (!m.handle) { const char* e = dlerror(); err = e ? e : "Could not load " + path; return nullptr; }
  using ModuleEntry = bool (*)(void*);
  auto entry = (ModuleEntry)dlsym(m.handle, "ModuleEntry");
  if (entry && !entry(m.handle)) { err = "ModuleEntry failed"; return nullptr; }
  auto gf = (GetFactory)dlsym(m.handle, "GetPluginFactory");
#endif
  if (!gf) { err = "Not a VST3 plugin (no GetPluginFactory)"; return nullptr; }
  m.factory = gf();
  if (!m.factory) { err = "GetPluginFactory returned null"; return nullptr; }
  return &(gMods[path] = m);
}

// ------------------------------------------------------------------------------------- host objects
class HostAttributes : public IAttributeList {
 public:
  D3_REFCOUNT_DELETE
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override { return Query<HostAttributes, IAttributeList>::run(this, iid, obj); }
  tresult PLUGIN_API setInt(AttrID id, int64 v) override { ints_[id] = v; return kResultOk; }
  tresult PLUGIN_API getInt(AttrID id, int64& v) override { auto it = ints_.find(id); if (it == ints_.end()) return kResultFalse; v = it->second; return kResultOk; }
  tresult PLUGIN_API setFloat(AttrID id, double v) override { floats_[id] = v; return kResultOk; }
  tresult PLUGIN_API getFloat(AttrID id, double& v) override { auto it = floats_.find(id); if (it == floats_.end()) return kResultFalse; v = it->second; return kResultOk; }
  tresult PLUGIN_API setString(AttrID id, const TChar* s) override {
    std::u16string v;
    for (; s && *s; ++s) v += (char16_t)*s;
    strings_[id] = v;
    return kResultOk;
  }
  tresult PLUGIN_API getString(AttrID id, TChar* s, uint32 sizeBytes) override {
    auto it = strings_.find(id);
    if (it == strings_.end() || !sizeBytes) return kResultFalse;
    size_t n = std::min<size_t>(it->second.size(), sizeBytes / sizeof(TChar) - 1);
    for (size_t i = 0; i < n; i++) s[i] = (TChar)it->second[i];
    s[n] = 0;
    return kResultOk;
  }
  tresult PLUGIN_API setBinary(AttrID id, const void* d, uint32 n) override { bins_[id].assign((const uint8_t*)d, (const uint8_t*)d + n); return kResultOk; }
  tresult PLUGIN_API getBinary(AttrID id, const void*& d, uint32& n) override {
    auto it = bins_.find(id);
    if (it == bins_.end()) return kResultFalse;
    d = it->second.data();
    n = (uint32)it->second.size();
    return kResultOk;
  }

 private:
  std::map<std::string, int64> ints_;
  std::map<std::string, double> floats_;
  std::map<std::string, std::u16string> strings_;
  std::map<std::string, std::vector<uint8_t>> bins_;
};

class HostMessage : public IMessage {
 public:
  D3_REFCOUNT_DELETE
  ~HostMessage() { attrs_->release(); }
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override { return Query<HostMessage, IMessage>::run(this, iid, obj); }
  FIDString PLUGIN_API getMessageID() override { return id_.c_str(); }
  void PLUGIN_API setMessageID(FIDString id) override { id_ = id ? id : ""; }
  IAttributeList* PLUGIN_API getAttributes() override { return attrs_; }

 private:
  std::string id_;
  HostAttributes* attrs_ = new HostAttributes();
};

class HostApp : public IHostApplication {
 public:
  D3_REFCOUNT_STATIC
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override { return Query<HostApp, IHostApplication>::run(this, iid, obj); }
  tresult PLUGIN_API getName(String128 name) override { v3::toString128("daW3", name); return kResultOk; }
  tresult PLUGIN_API createInstance(TUID cid, TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(cid, IMessage::iid) && FUnknownPrivate::iidEqual(iid, IMessage::iid)) { *obj = static_cast<IMessage*>(new HostMessage()); return kResultOk; }
    if (FUnknownPrivate::iidEqual(cid, IAttributeList::iid) && FUnknownPrivate::iidEqual(iid, IAttributeList::iid)) { *obj = static_cast<IAttributeList*>(new HostAttributes()); return kResultOk; }
    *obj = nullptr;
    return kResultFalse;
  }
};
HostApp gHostApp;

class ParamQueue : public IParamValueQueue {
 public:
  D3_REFCOUNT_STATIC
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override { return Query<ParamQueue, IParamValueQueue>::run(this, iid, obj); }
  ParamID PLUGIN_API getParameterId() override { return id; }
  int32 PLUGIN_API getPointCount() override { return (int32)n; }
  tresult PLUGIN_API getPoint(int32 i, int32& off, ParamValue& v) override {
    if (i < 0 || (size_t)i >= n) return kResultFalse;
    off = pts[i].first;
    v = pts[i].second;
    return kResultOk;
  }
  tresult PLUGIN_API addPoint(int32 off, ParamValue v, int32& index) override {
    if (n >= pts.size()) return kResultFalse;
    pts[n] = {off, v};
    index = (int32)n++;
    return kResultOk;
  }
  ParamID id = 0;
  size_t n = 0;
  std::array<std::pair<int32, ParamValue>, 64> pts;
};

class ParamChanges : public IParameterChanges {
 public:
  ParamChanges() { qs_.resize(256); }
  D3_REFCOUNT_STATIC
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override { return Query<ParamChanges, IParameterChanges>::run(this, iid, obj); }
  int32 PLUGIN_API getParameterCount() override { return (int32)used_; }
  IParamValueQueue* PLUGIN_API getParameterData(int32 i) override { return i >= 0 && (size_t)i < used_ ? &qs_[i] : nullptr; }
  IParamValueQueue* PLUGIN_API addParameterData(const ParamID& id, int32& index) override {
    for (size_t i = 0; i < used_; i++) if (qs_[i].id == id) { index = (int32)i; return &qs_[i]; }
    if (used_ >= qs_.size()) return nullptr;
    qs_[used_].id = id;
    qs_[used_].n = 0;
    index = (int32)used_;
    return &qs_[used_++];
  }
  void clear() { used_ = 0; }
  void add(ParamID id, int32 off, double v) {
    int32 idx;
    if (auto* q = addParameterData(id, idx)) q->addPoint(off, v, idx);
  }

 private:
  std::vector<ParamQueue> qs_;
  size_t used_ = 0;
};

class Events : public IEventList {
 public:
  Events() { ev_.reserve(1024); }
  D3_REFCOUNT_STATIC
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override { return Query<Events, IEventList>::run(this, iid, obj); }
  int32 PLUGIN_API getEventCount() override { return (int32)ev_.size(); }
  tresult PLUGIN_API getEvent(int32 i, Event& e) override { if (i < 0 || (size_t)i >= ev_.size()) return kResultFalse; e = ev_[i]; return kResultOk; }
  tresult PLUGIN_API addEvent(Event& e) override { if (ev_.size() == ev_.capacity()) return kResultFalse; ev_.push_back(e); return kResultOk; }
  void clear() { ev_.clear(); }

 private:
  std::vector<Event> ev_;
};

// ------------------------------------------------------------------------------------- instance
class Vst3Instance : public PluginInstance, public IComponentHandler, public IPlugFrame {
 public:
  explicit Vst3Instance(const PluginDesc& d) : desc_(d) {}
  D3_REFCOUNT_STATIC
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override { return Query<Vst3Instance, IComponentHandler, IPlugFrame>::run(this, iid, obj); }

  ~Vst3Instance() override {
    closeEditor();
    deactivate();
    if (compCP_ && ctrlCP_) { compCP_->disconnect(ctrlCP_); ctrlCP_->disconnect(compCP_); }
    if (compCP_) compCP_->release();
    if (ctrlCP_) ctrlCP_->release();
    if (midiMap_) midiMap_->release();
    if (ctrl_) { ctrl_->setComponentHandler(nullptr); if (!singleComponent_) ctrl_->terminate(); ctrl_->release(); }
    if (proc_) proc_->release();
    if (comp_) { comp_->terminate(); comp_->release(); }
  }

  bool init(IPluginFactory* f, std::string& err) {
    TUID cid;
    if (!v3::parseTuid(desc_.uid, cid)) { err = "Bad VST3 class id"; return false; }
    if (f->createInstance(cid, IComponent::iid, (void**)&comp_) != kResultOk || !comp_) { err = "Could not create the VST3 component"; return false; }
    if (comp_->initialize(&gHostApp) != kResultOk) { err = "VST3 component initialize failed"; return false; }
    if (comp_->queryInterface(IAudioProcessor::iid, (void**)&proc_) != kResultOk) { err = "VST3 component has no audio processor"; return false; }
    if (comp_->queryInterface(IEditController::iid, (void**)&ctrl_) == kResultOk && ctrl_) {
      singleComponent_ = true;
    } else {
      TUID ccid;
      if (comp_->getControllerClassId(ccid) == kResultOk && f->createInstance(ccid, IEditController::iid, (void**)&ctrl_) == kResultOk && ctrl_) {
        if (ctrl_->initialize(&gHostApp) != kResultOk) { ctrl_->release(); ctrl_ = nullptr; }
      }
    }
    if (ctrl_) {
      ctrl_->setComponentHandler(this);
      if (!singleComponent_ && comp_->queryInterface(IConnectionPoint::iid, (void**)&compCP_) == kResultOk &&
          ctrl_->queryInterface(IConnectionPoint::iid, (void**)&ctrlCP_) == kResultOk) {
        compCP_->connect(ctrlCP_);
        ctrlCP_->connect(compCP_);
      }
      v3::MemoryStream s;
      if (comp_->getState(&s) == kResultOk) { s.rewind(); ctrl_->setComponentState(&s); }
      ctrl_->queryInterface(IMidiMapping::iid, (void**)&midiMap_);
    }
    BusInfo bi;
    desc_.numInputs = desc_.numOutputs = 0;
    if (comp_->getBusCount(kAudio, kInput) > 0 && comp_->getBusInfo(kAudio, kInput, 0, bi) == kResultOk) desc_.numInputs = bi.channelCount;
    if (comp_->getBusCount(kAudio, kOutput) > 0 && comp_->getBusInfo(kAudio, kOutput, 0, bi) == kResultOk) desc_.numOutputs = bi.channelCount;
    desc_.midiInput = comp_->getBusCount(kEvent, kInput) > 0;
    return true;
  }

  const PluginDesc& desc() const override { return desc_; }

  bool activate(double sr, uint32_t maxFrames, std::string& err) override {
    deactivate();
    SpeakerArrangement inArr = desc_.numInputs == 1 ? SpeakerArr::kMono : SpeakerArr::kStereo;
    SpeakerArrangement outArr = desc_.numOutputs == 1 ? SpeakerArr::kMono : SpeakerArr::kStereo;
    proc_->setBusArrangements(desc_.numInputs ? &inArr : nullptr, desc_.numInputs ? 1 : 0, desc_.numOutputs ? &outArr : nullptr, desc_.numOutputs ? 1 : 0);
    BusInfo bi;
    if (comp_->getBusCount(kAudio, kInput) > 0 && comp_->getBusInfo(kAudio, kInput, 0, bi) == kResultOk) desc_.numInputs = bi.channelCount;
    if (comp_->getBusCount(kAudio, kOutput) > 0 && comp_->getBusInfo(kAudio, kOutput, 0, bi) == kResultOk) desc_.numOutputs = bi.channelCount;
    // only the main buses are used: activate them, deactivate the rest
    for (int dir = 0; dir < 2; dir++) {
      const int32 na = comp_->getBusCount(kAudio, dir), ne = comp_->getBusCount(kEvent, dir);
      for (int32 i = 0; i < na; i++) comp_->activateBus(kAudio, dir, i, i == 0);
      for (int32 i = 0; i < ne; i++) comp_->activateBus(kEvent, dir, i, i == 0 && dir == kInput);
    }
    ProcessSetup ps{offline_ ? kOffline : kRealtime, kSample32, (int32)maxFrames, sr};
    if (proc_->setupProcessing(ps) != kResultOk) { err = "VST3 setupProcessing failed"; return false; }
    if (comp_->setActive(true) != kResultOk) { err = "VST3 setActive failed"; return false; }
    sr_ = sr;
    active_ = true;
    processing_ = false;
    inPtrs_.assign(std::max(1, desc_.numInputs), nullptr);
    outPtrs_.assign(std::max(1, desc_.numOutputs), nullptr);
    silence_.assign(maxFrames, 0.f);
    scratch_.assign((size_t)maxFrames * std::max(1, desc_.numOutputs), 0.f);
    return true;
  }

  void deactivate() override {
    if (!active_) return;
    if (processing_) { proc_->setProcessing(false); processing_ = false; }
    comp_->setActive(false);
    active_ = false;
  }

  void process(ProcessBlock& b) override {
    for (uint32_t c = 0; c < b.numOut; c++) std::memset(b.out[c], 0, sizeof(float) * b.nframes);
    if (!active_) return;
    if (!processing_) { proc_->setProcessing(true); processing_ = true; }
    inChanges_.clear();
    outChanges_.clear();
    events_.clear();
    {
      std::unique_lock<std::mutex> l(pendingM_, std::try_to_lock);
      if (l.owns_lock()) { for (auto& p : pending_) inChanges_.add(p.first, 0, p.second); pending_.clear(); }
    }
    for (uint32_t i = 0; i < b.paramCount; i++) inChanges_.add(b.params[i].id, (int32)std::min(b.params[i].offset, b.nframes - 1), b.params[i].value);
    for (uint32_t i = 0; i < b.midiCount; i++) addMidi(b.midi[i], b.nframes);
    const int nin = desc_.numInputs, nout = desc_.numOutputs;
    for (int c = 0; c < nin; c++) inPtrs_[c] = const_cast<float*>((uint32_t)c < b.numIn ? b.in[c] : (b.numIn ? b.in[b.numIn - 1] : silence_.data()));
    for (int c = 0; c < nout; c++) outPtrs_[c] = (uint32_t)c < b.numOut ? b.out[c] : scratch_.data() + (size_t)c * silence_.size();
    AudioBusBuffers in{}, out{};
    in.numChannels = nin;
    in.channelBuffers32 = inPtrs_.data();
    out.numChannels = nout;
    out.channelBuffers32 = outPtrs_.data();
    ProcessContext ctx{};
    ctx.state = ProcessContext::kTempoValid | ProcessContext::kProjectTimeMusicValid | (b.playing ? ProcessContext::kPlaying : 0);
    ctx.sampleRate = sr_;
    ctx.tempo = b.tempo;
    ctx.projectTimeMusic = b.ppqPos;
    ctx.projectTimeSamples = (int64)samplePos_;
    ProcessData d;
    d.processMode = offline_ ? kOffline : kRealtime;
    d.symbolicSampleSize = kSample32;
    d.numSamples = (int32)b.nframes;
    d.numInputs = nin ? 1 : 0;
    d.numOutputs = nout ? 1 : 0;
    d.inputs = nin ? &in : nullptr;
    d.outputs = nout ? &out : nullptr;
    d.inputParameterChanges = &inChanges_;
    d.outputParameterChanges = &outChanges_;
    d.inputEvents = desc_.midiInput ? &events_ : nullptr;
    d.processContext = &ctx;
    proc_->process(d);
    if (nout == 1 && b.numOut > 1) std::memcpy(b.out[1], b.out[0], sizeof(float) * b.nframes);
    samplePos_ += b.nframes;
    if (b.outParams) {
      for (int32 i = 0; i < outChanges_.getParameterCount(); i++) {
        IParamValueQueue* q = outChanges_.getParameterData(i);
        int32 off;
        ParamValue v;
        if (q && q->getPointCount() > 0 && q->getPoint(q->getPointCount() - 1, off, v) == kResultOk && b.outParams->size() < b.outParams->capacity())
          b.outParams->push_back({(uint32_t)off, q->getParameterId(), v});
      }
    }
  }

  std::vector<ParamInfo> params() override {
    std::vector<ParamInfo> out;
    if (!ctrl_) return out;
    const int32 n = ctrl_->getParameterCount();
    for (int32 i = 0; i < n; i++) {
      Vst::ParameterInfo pi{};
      if (ctrl_->getParameterInfo(i, pi) != kResultOk) continue;
      ParamInfo p;
      p.id = pi.id;
      p.name = v3::utf8(pi.title);
      p.unit = v3::utf8(pi.units);
      p.min = 0;
      p.max = 1;
      p.def = pi.defaultNormalizedValue;
      p.steps = pi.stepCount;
      p.flags = 0;
      if (pi.flags & Vst::ParameterInfo::kCanAutomate) p.flags |= kParamAutomatable;
      if (pi.stepCount > 0) p.flags |= kParamStepped;
      if (pi.flags & Vst::ParameterInfo::kIsHidden) p.flags |= kParamHidden;
      if (pi.flags & Vst::ParameterInfo::kIsReadOnly) p.flags |= kParamReadOnly;
      if (pi.flags & Vst::ParameterInfo::kIsBypass) p.flags |= kParamBypass;
      out.push_back(p);
    }
    return out;
  }

  double getParam(uint32_t id) override { return ctrl_ ? ctrl_->getParamNormalized(id) : 0; }

  void setParam(uint32_t id, double v) override {
    v = std::clamp(v, 0.0, 1.0);
    if (ctrl_) ctrl_->setParamNormalized(id, v);
    std::lock_guard<std::mutex> g(pendingM_);
    pending_.emplace_back(id, v);
  }

  bool getState(std::vector<uint8_t>& out) override {
    v3::MemoryStream cs, ks;
    if (comp_->getState(&cs) != kResultOk) return false;
    if (ctrl_ && !singleComponent_) ctrl_->getState(&ks);
    out.assign({'D', '3', 'V', '3'});
    auto put = [&](const std::vector<uint8_t>& d) {
      uint32_t n = (uint32_t)d.size();
      for (int i = 0; i < 4; i++) out.push_back((uint8_t)(n >> (8 * i)));
      out.insert(out.end(), d.begin(), d.end());
    };
    put(cs.data());
    put(ks.data());
    return true;
  }

  bool setState(const std::vector<uint8_t>& in) override {
    if (in.size() < 12 || std::memcmp(in.data(), "D3V3", 4)) return false;
    size_t pos = 4;
    auto take = [&](std::vector<uint8_t>& d) {
      if (pos + 4 > in.size()) return false;
      uint32_t n = 0;
      for (int i = 0; i < 4; i++) n |= (uint32_t)in[pos + i] << (8 * i);
      pos += 4;
      if (pos + n > in.size()) return false;
      d.assign(in.begin() + (long)pos, in.begin() + (long)(pos + n));
      pos += n;
      return true;
    };
    std::vector<uint8_t> c, k;
    if (!take(c) || !take(k)) return false;
    v3::MemoryStream cs(c);
    if (comp_->setState(&cs) != kResultOk) return false;
    if (ctrl_) {
      v3::MemoryStream cs2(c);
      ctrl_->setComponentState(&cs2);
      if (!k.empty()) { v3::MemoryStream ks(k); ctrl_->setState(&ks); }
    }
    return true;
  }

  uint32_t latency() override { return proc_ ? proc_->getLatencySamples() : 0; }
  uint32_t tailSamples() override { uint32 t = proc_ ? proc_->getTailSamples() : 0; return t == kInfiniteTail ? 0 : t; }
  bool supportsOffline() override { return true; }
  void setOffline(bool off) override {
    if (off == offline_) return;
    offline_ = off;
    if (active_) { std::string e; activate(sr_, (uint32_t)silence_.size(), e); }
  }

  bool hasEditor() override {
#ifdef __APPLE__
    if (!ctrl_) return false;
    if (IPlugView* v = ctrl_->createView(ViewType::kEditor)) {
      bool ok = v->isPlatformTypeSupported(kPlatformTypeNSView) == kResultTrue;
      v->release();
      return ok;
    }
#endif
    return false;
  }

  bool openEditor(std::string& err) override {
#ifdef __APPLE__
    if (view_) return true;
    if (!ctrl_ || !(view_ = ctrl_->createView(ViewType::kEditor))) { err = "This plugin has no editor"; return false; }
    if (view_->isPlatformTypeSupported(kPlatformTypeNSView) != kResultTrue) { view_->release(); view_ = nullptr; err = "Editor not supported on macOS"; return false; }
    ViewRect r;
    if (view_->getSize(&r) != kResultOk) r = ViewRect(0, 0, 600, 400);
    window_ = guiCreateWindow(desc_.name, r.getWidth(), r.getHeight(), view_->canResize() == kResultTrue, [this, alive = alive_]() {
      if (!*alive) return;
      window_ = nullptr;
      if (view_) { view_->removed(); view_->setFrame(nullptr); view_->release(); view_ = nullptr; }
      auto l = listener();
      if (l.editorClosed) l.editorClosed();
    });
    view_->setFrame(this);
    if (view_->attached(guiWindowView(window_), kPlatformTypeNSView) != kResultOk) { closeEditor(); err = "The plugin could not attach its editor"; return false; }
    return true;
#else
    err = "Plugin editors are only available on macOS";
    return false;
#endif
  }

  void closeEditor() override {
    if (view_) { view_->removed(); view_->setFrame(nullptr); view_->release(); view_ = nullptr; }
    if (window_) { void* w = window_; window_ = nullptr; guiCloseWindow(w); }
  }

  // IComponentHandler
  tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API performEdit(ParamID id, ParamValue v) override {
    { std::lock_guard<std::mutex> g(pendingM_); pending_.emplace_back(id, v); }
    auto l = listener();
    if (l.paramChanged) l.paramChanged(id, v);
    return kResultOk;
  }
  tresult PLUGIN_API endEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API restartComponent(int32 flags) override {
    auto l = listener();
    if ((flags & kLatencyChanged) && l.latencyChanged) l.latencyChanged();
    if ((flags & (kParamValuesChanged | kParamTitlesChanged)) && l.paramsRescanned) l.paramsRescanned();
    return kResultOk;
  }
  // IPlugFrame
  tresult PLUGIN_API resizeView(IPlugView* v, ViewRect* r) override {
    if (!v || !r) return kInvalidArgument;
    if (window_) guiResizeWindow(window_, r->getWidth(), r->getHeight());
    v->onSize(r);
    return kResultOk;
  }

 private:
  void addMidi(const MidiEvt& m, uint32_t nframes) {
    const uint8_t st = m.data[0] & 0xF0, ch = m.data[0] & 0x0F;
    const int32 off = (int32)std::min(m.offset, nframes ? nframes - 1 : 0);
    Event e{};
    e.busIndex = 0;
    e.sampleOffset = off;
    if (st == 0x90 && m.data[2] > 0) {
      e.type = Event::kNoteOnEvent;
      e.noteOn = {(int16)ch, (int16)m.data[1], 0.f, m.data[2] / 127.f, 0, -1};
      events_.addEvent(e);
    } else if (st == 0x80 || st == 0x90) {
      e.type = Event::kNoteOffEvent;
      e.noteOff = {(int16)ch, (int16)m.data[1], m.data[2] / 127.f, -1, 0.f};
      events_.addEvent(e);
    } else if (midiMap_ && (st == 0xB0 || st == 0xE0 || st == 0xD0)) {
      CtrlNumber cc = st == 0xB0 ? m.data[1] : st == 0xE0 ? (CtrlNumber)kPitchBend : (CtrlNumber)kAfterTouch;
      ParamID pid;
      if (midiMap_->getMidiControllerAssignment(0, ch, cc, pid) == kResultTrue) {
        double v = st == 0xE0 ? ((m.data[2] << 7) | m.data[1]) / 16383.0 : (st == 0xB0 ? m.data[2] : m.data[1]) / 127.0;
        inChanges_.add(pid, off, v);
      }
    }
  }

  PluginDesc desc_;
  IComponent* comp_ = nullptr;
  IAudioProcessor* proc_ = nullptr;
  IEditController* ctrl_ = nullptr;
  IConnectionPoint *compCP_ = nullptr, *ctrlCP_ = nullptr;
  IMidiMapping* midiMap_ = nullptr;
  IPlugView* view_ = nullptr;
  void* window_ = nullptr;
  bool singleComponent_ = false, active_ = false, processing_ = false, offline_ = false;
  double sr_ = 48000;
  uint64_t samplePos_ = 0;
  ParamChanges inChanges_, outChanges_;
  Events events_;
  std::mutex pendingM_;
  std::vector<std::pair<ParamID, double>> pending_;
  std::vector<float*> inPtrs_, outPtrs_;
  std::vector<float> silence_, scratch_;
  std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

// ------------------------------------------------------------------------------------- format
class Vst3Format : public PluginFormat {
 public:
  std::string name() const override { return "vst3"; }
  std::string bundleExtension() const override { return ".vst3"; }
  std::vector<std::string> defaultPaths() const override {
#ifdef __APPLE__
    return {homeDir() + "/Library/Audio/Plug-Ins/VST3", "/Library/Audio/Plug-Ins/VST3"};
#else
    return {homeDir() + "/.vst3", "/usr/lib/vst3", "/usr/local/lib/vst3"};
#endif
  }

  bool describe(const std::string& path, std::vector<PluginDesc>& out, std::string& err) override {
    const Vst3Module* m = loadModule(path, err);
    if (!m) return false;
    PFactoryInfo fi{};
    m->factory->getFactoryInfo(&fi);
    IPluginFactory2* f2 = nullptr;
    m->factory->queryInterface(IPluginFactory2::iid, (void**)&f2);
    const int32 n = m->factory->countClasses();
    for (int32 i = 0; i < n; i++) {
      PClassInfo ci{};
      if (m->factory->getClassInfo(i, &ci) != kResultOk) continue;
      if (std::strcmp(ci.category, kVstAudioEffectClass) != 0) continue;
      PluginDesc d;
      d.format = "vst3";
      d.uid = v3::hexTuid(ci.cid);
      d.name = ci.name;
      d.vendor = fi.vendor;
      d.path = path;
      std::string sub;
      PClassInfo2 c2{};
      if (f2 && f2->getClassInfo2(i, &c2) == kResultOk) {
        sub = c2.subCategories;
        if (c2.vendor[0]) d.vendor = c2.vendor;
        d.version = c2.version;
      }
      d.instrument = sub.find("Instrument") != std::string::npos;
      d.midiInput = d.instrument;
      d.numInputs = d.instrument ? 0 : 2;
      d.category = sub.empty() ? (d.instrument ? "Instrument" : "Fx") : sub;
      out.push_back(d);
    }
    if (f2) f2->release();
    return true;
  }

  std::unique_ptr<PluginInstance> create(const PluginDesc& d, std::string& err) override {
    const Vst3Module* m = loadModule(d.path, err);
    if (!m) return nullptr;
    auto inst = std::make_unique<Vst3Instance>(d);
    if (!inst->init(m->factory, err)) return nullptr;
    return inst;
  }
};

}  // namespace

std::unique_ptr<PluginFormat> makeVst3Format() { return std::make_unique<Vst3Format>(); }

}  // namespace daw3
