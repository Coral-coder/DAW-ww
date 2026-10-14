// VST3 hosting on the MIT-licensed VST3 pluginterfaces only (v3.8.0).
#include <dlfcn.h>

#include <algorithm>
#include <array>
#include <map>
#include <mutex>
#include <strings.h>

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
#include "pluginterfaces/vst/ivstunits.h"
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
DEF_CLASS_IID(IUnitInfo)
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
  std::array<std::pair<int32, ParamValue>, 512> pts;
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
    if (units_) units_->release();
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
      ctrl_->queryInterface(IUnitInfo::iid, (void**)&units_);
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
    readBuses();
    desc_.midiInput = comp_->getBusCount(kEvent, kInput) > 0;
    return true;
  }

  /** Audio buses -> main input, sidechain (first aux input bus), every output bus. */
  void readBuses() {
    inCh_.clear();
    outCh_.clear();
    mainIn_ = scIn_ = -1;
    desc_.numInputs = desc_.numOutputs = 0;
    desc_.sidechainChannels = 0;
    desc_.outputBuses.clear();
    BusInfo bi;
    const int32 ni = std::min<int32>(comp_->getBusCount(kAudio, kInput), 8);
    for (int32 i = 0; i < ni; i++) {
      if (comp_->getBusInfo(kAudio, kInput, i, bi) != kResultOk) { inCh_.push_back(0); continue; }
      inCh_.push_back(std::min<int32>(bi.channelCount, 8));
      if (bi.busType == kMain && mainIn_ < 0) mainIn_ = i;
      else if (bi.busType == kAux && scIn_ < 0) scIn_ = i;
    }
    if (mainIn_ < 0 && ni > 0 && scIn_ != 0) mainIn_ = 0;
    if (mainIn_ >= 0) desc_.numInputs = inCh_[mainIn_];
    if (scIn_ >= 0) desc_.sidechainChannels = inCh_[scIn_];
    const int32 no = std::min<int32>(comp_->getBusCount(kAudio, kOutput), 16);
    for (int32 i = 0; i < no; i++) {
      AudioBus bus;
      bus.channels = 0;
      if (comp_->getBusInfo(kAudio, kOutput, i, bi) == kResultOk) { bus.channels = std::min<int32>(bi.channelCount, 8); bus.name = v3::utf8(bi.name); }
      if (bus.name.empty()) bus.name = i == 0 ? "Main" : "Out " + std::to_string(i + 1);
      outCh_.push_back(bus.channels);
      desc_.outputBuses.push_back(bus);
    }
    if (!outCh_.empty()) desc_.numOutputs = outCh_[0];
  }

  const PluginDesc& desc() const override { return desc_; }

  bool activate(double sr, uint32_t maxFrames, std::string& err) override {
    deactivate();
    // mono / stereo main buses, the plugin's own arrangement for the others
    auto arrOf = (SpeakerArrangement(*)(int))[](int ch) { return ch == 1 ? SpeakerArr::kMono : SpeakerArr::kStereo; };
    std::vector<SpeakerArrangement> ia(inCh_.size()), oa(outCh_.size());
    for (size_t i = 0; i < ia.size(); i++) { if (proc_->getBusArrangement(kInput, (int32)i, ia[i]) != kResultOk || inCh_[i] <= 2) ia[i] = arrOf(inCh_[i]); }
    for (size_t i = 0; i < oa.size(); i++) { if (proc_->getBusArrangement(kOutput, (int32)i, oa[i]) != kResultOk || outCh_[i] <= 2) oa[i] = arrOf(outCh_[i]); }
    proc_->setBusArrangements(ia.empty() ? nullptr : ia.data(), (int32)ia.size(), oa.empty() ? nullptr : oa.data(), (int32)oa.size());
    readBuses();
    // main input, the sidechain bus and every output bus are used; the first event input
    for (int dir = 0; dir < 2; dir++) {
      const int32 na = comp_->getBusCount(kAudio, dir), ne = comp_->getBusCount(kEvent, dir);
      for (int32 i = 0; i < na; i++) comp_->activateBus(kAudio, dir, i, dir == kOutput ? i < 16 : (i == mainIn_ || i == scIn_));
      for (int32 i = 0; i < ne; i++) comp_->activateBus(kEvent, dir, i, i == 0 && dir == kInput);
    }
    ProcessSetup ps{offline_ ? kOffline : kRealtime, kSample32, (int32)maxFrames, sr};
    if (proc_->setupProcessing(ps) != kResultOk) { err = "VST3 setupProcessing failed"; return false; }
    if (comp_->setActive(true) != kResultOk) { err = "VST3 setActive failed"; return false; }
    sr_ = sr;
    maxFrames_ = maxFrames;
    active_ = true;
    processing_ = false;
    inPtrs_.assign(inCh_.size(), {});
    for (size_t i = 0; i < inCh_.size(); i++) inPtrs_[i].assign(std::max(1, inCh_[i]), nullptr);
    outPtrs_.assign(outCh_.size(), {});
    for (size_t i = 0; i < outCh_.size(); i++) outPtrs_[i].assign(std::max(1, outCh_[i]), nullptr);
    inBufs_.assign(inCh_.size(), AudioBusBuffers{});
    outBufs_.assign(outCh_.size(), AudioBusBuffers{});
    silence_.assign(maxFrames, 0.f);
    scratch_.assign((size_t)maxFrames * std::max(1, desc_.totalOutputs()), 0.f);
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
    // every bus gets buffers: main in = the block's input, sidechain = its key, other inputs silence;
    // outputs map bus after bus onto b.out (the rest -> scratch)
    for (size_t i = 0; i < inCh_.size(); i++) {
      const float* const* src = (int)i == mainIn_ ? b.in : (int)i == scIn_ ? b.sc : nullptr;
      const uint32_t n = (int)i == mainIn_ ? b.numIn : (int)i == scIn_ ? b.numSc : 0;
      for (int c = 0; c < inCh_[i]; c++) inPtrs_[i][c] = const_cast<float*>(src && n ? src[std::min<uint32_t>((uint32_t)c, n - 1)] : silence_.data());
      inBufs_[i] = AudioBusBuffers{};
      inBufs_[i].numChannels = inCh_[i];
      inBufs_[i].channelBuffers32 = inPtrs_[i].data();
    }
    uint32_t oc = 0;
    for (size_t i = 0; i < outCh_.size(); i++) {
      for (int c = 0; c < outCh_[i]; c++, oc++) outPtrs_[i][c] = oc < b.numOut ? b.out[oc] : scratch_.data() + (size_t)oc * maxFrames_;
      outBufs_[i] = AudioBusBuffers{};
      outBufs_[i].numChannels = outCh_[i];
      outBufs_[i].channelBuffers32 = outPtrs_[i].data();
    }
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
    d.numInputs = (int32)inBufs_.size();
    d.numOutputs = (int32)outBufs_.size();
    d.inputs = inBufs_.empty() ? nullptr : inBufs_.data();
    d.outputs = outBufs_.empty() ? nullptr : outBufs_.data();
    d.inputParameterChanges = &inChanges_;
    d.outputParameterChanges = &outChanges_;
    d.inputEvents = desc_.midiInput ? &events_ : nullptr;
    d.processContext = &ctx;
    proc_->process(d);
    if (outCh_.size() == 1 && outCh_[0] == 1 && b.numOut > 1) std::memcpy(b.out[1], b.out[0], sizeof(float) * b.nframes);
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
      if (pi.flags & Vst::ParameterInfo::kIsProgramChange) p.flags |= kParamHidden | kParamStepped;  // presets pick programs
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
    return applyStates(c, k);
  }

  /** Component state (+ controller state, may be empty) into the plugin. */
  bool applyStates(const std::vector<uint8_t>& c, const std::vector<uint8_t>& k) {
    v3::MemoryStream cs(c);
    if (comp_->setState(&cs) != kResultOk) return false;
    if (ctrl_) {
      v3::MemoryStream cs2(c);
      ctrl_->setComponentState(&cs2);
      if (!k.empty()) { v3::MemoryStream ks(k); ctrl_->setState(&ks); }
    }
    return true;
  }

  // ---- presets: program lists (IUnitInfo + the program-change parameter) and .vstpreset files
  static bool readVstPreset(const std::string& path, std::string& cls, std::vector<uint8_t>& c, std::vector<uint8_t>& k) {
    std::vector<uint8_t> d;
    return readFile(path, d) && v3::parseVstPreset(d, cls, c, k);
  }

  struct ProgramList { ProgramListID id; int32 count; std::string name; ParamID param; };
  std::vector<ProgramList> programLists() {
    std::vector<ProgramList> out;
    if (!units_ || !ctrl_) return out;
    // unit -> program list, and the program-change parameter of each unit
    std::map<UnitID, ProgramListID> unitList;
    for (int32 i = 0; i < units_->getUnitCount(); i++) {
      UnitInfo ui{};
      if (units_->getUnitInfo(i, ui) == kResultOk && ui.programListId != kNoProgramListId) unitList[ui.id] = ui.programListId;
    }
    std::map<ProgramListID, ParamID> listParam;
    for (int32 i = 0; i < ctrl_->getParameterCount(); i++) {
      Vst::ParameterInfo pi{};
      if (ctrl_->getParameterInfo(i, pi) != kResultOk || !(pi.flags & Vst::ParameterInfo::kIsProgramChange)) continue;
      auto it = unitList.find(pi.unitId);
      const ProgramListID lid = it != unitList.end() ? it->second : (unitList.empty() ? kNoProgramListId : unitList.begin()->second);
      if (!listParam.count(lid)) listParam[lid] = pi.id;
    }
    for (int32 i = 0; i < units_->getProgramListCount(); i++) {
      ProgramListInfo li{};
      if (units_->getProgramListInfo(i, li) != kResultOk || li.programCount <= 0) continue;
      auto it = listParam.find(li.id);
      if (it == listParam.end()) continue;  // no parameter selects it: not loadable from the host side
      out.push_back({li.id, li.programCount, v3::utf8(li.name), it->second});
    }
    return out;
  }

  std::vector<PresetInfo> presets() override {
    std::vector<PresetInfo> out;
    for (auto& pl : programLists()) {
      for (int32 k = 0; k < pl.count && k < 1024; k++) {
        String128 nm{};
        PresetInfo p;
        p.kind = "factory";
        p.category = pl.name;
        p.name = units_->getProgramName(pl.id, k, nm) == kResultOk ? v3::utf8(nm) : "Program " + std::to_string(k + 1);
        p.id = "program:" + std::to_string(pl.id) + ":" + std::to_string(k);
        out.push_back(p);
      }
    }
    for (auto& [path, cat] : findPresetFiles(presetFolders(desc_), ".vstpreset")) {
      std::vector<uint8_t> c, k;
      std::string cls;
      if (!readVstPreset(path, cls, c, k) || strcasecmp(cls.c_str(), desc_.uid.c_str()) != 0) continue;  // another plugin's preset
      PresetInfo p;
      p.kind = "file";
      p.path = path;
      p.category = cat;
      p.name = stripExt(baseName(path));
      p.id = "file:" + path;
      out.push_back(p);
    }
    return out;
  }

  bool loadPreset(const std::string& id, std::string& err) override {
    if (id.rfind("program:", 0) == 0) {
      const size_t a = id.find(':', 8);
      if (a == std::string::npos) { err = "Bad preset id"; return false; }
      const ProgramListID lid = (ProgramListID)atol(id.substr(8, a - 8).c_str());
      const int32 k = (int32)atol(id.substr(a + 1).c_str());
      for (auto& pl : programLists()) {
        if (pl.id != lid) continue;
        if (k < 0 || k >= pl.count) break;
        setParam(pl.param, pl.count > 1 ? (double)k / (pl.count - 1) : 0.0);
        auto l = listener();
        if (l.paramsRescanned) l.paramsRescanned();
        return true;
      }
      err = "No such program";
      return false;
    }
    if (id.rfind("file:", 0) == 0) {
      std::vector<uint8_t> c, k;
      std::string cls;
      if (!readVstPreset(id.substr(5), cls, c, k)) { err = "Not a VST3 preset file"; return false; }
      if (strcasecmp(cls.c_str(), desc_.uid.c_str()) != 0) { err = "The preset belongs to another plugin"; return false; }
      if (c.empty() || !applyStates(c, k)) { err = "The plugin rejected the preset"; return false; }
      auto l = listener();
      if (l.paramsRescanned) l.paramsRescanned();
      return true;
    }
    err = "Bad preset id";
    return false;
  }

  bool savePreset(const std::string& path, std::string& err) override {
    v3::MemoryStream cs, ks;
    if (comp_->getState(&cs) != kResultOk) { err = "The plugin does not save a state"; return false; }
    if (ctrl_ && !singleComponent_) ctrl_->getState(&ks);
    if (!writeFile(path, v3::makeVstPreset(desc_.uid, cs.data(), ks.data()))) { err = "Could not write " + path; return false; }
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
  IUnitInfo* units_ = nullptr;
  std::vector<int> inCh_, outCh_;
  int mainIn_ = -1, scIn_ = -1;
  uint32_t maxFrames_ = 0;
  std::vector<std::vector<float*>> inPtrs_, outPtrs_;
  std::vector<AudioBusBuffers> inBufs_, outBufs_;
  IPlugView* view_ = nullptr;
  void* window_ = nullptr;
  bool singleComponent_ = false, active_ = false, processing_ = false, offline_ = false;
  double sr_ = 48000;
  uint64_t samplePos_ = 0;
  ParamChanges inChanges_, outChanges_;
  Events events_;
  std::mutex pendingM_;
  std::vector<std::pair<ParamID, double>> pending_;
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
