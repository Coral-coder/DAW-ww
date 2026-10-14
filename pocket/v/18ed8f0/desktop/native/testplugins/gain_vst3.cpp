// Test VST3 plugins built in CI on the MIT VST3 pluginterfaces only. Each class is one component that is
// also its own edit controller (and IUnitInfo):
//   "daW3 Test Gain (VST3)"  param 0 "Gain" (normalized; gain = 2 * value, default 0.5 = unity), applied
//                            sample-accurately from the parameter queue; param 1 "Program" (program change,
//                            program list 1: Unity / Double / Silent); 32 samples latency; state = the gain
//   "daW3 Test Duck (VST3)"  same gain, plus a stereo aux (sidechain) input bus: out = in * g * (1 - min(1, |key|))
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>

#include "../src/host/vst3_common.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivstunits.h"
#include "pluginterfaces/vst/vstspeaker.h"

#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#endif

namespace Steinberg {
namespace Vst {
DEF_CLASS_IID(IComponent)
DEF_CLASS_IID(IAudioProcessor)
DEF_CLASS_IID(IEditController)
DEF_CLASS_IID(IUnitInfo)
}  // namespace Vst
}  // namespace Steinberg

using namespace Steinberg;
using namespace Steinberg::Vst;
using daw3::v3::Query;

static const TUID kGainCid = INLINE_UID(0xD3A00001, 0x7E57AB1E, 0x0000CAFE, 0x00000001);
static const TUID kDuckCid = INLINE_UID(0xD3A00001, 0x7E57AB1E, 0x0000CAFE, 0x00000002);

static const char* kProgramNames[] = {"Unity", "Double", "Silent"};
static const double kProgramGain[] = {0.5, 1.0, 0.0};
constexpr int32 kPrograms = 3;
constexpr ProgramListID kListId = 1;

class Gain : public IComponent, public IAudioProcessor, public IEditController, public IUnitInfo {
 public:
  explicit Gain(bool duck) : duck_(duck) {}
  D3_REFCOUNT_DELETE
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(iid, IPluginBase::iid)) { *obj = static_cast<IComponent*>(this); addRef(); return kResultOk; }
    return Query<Gain, IComponent, IAudioProcessor, IEditController, IUnitInfo>::run(this, iid, obj);
  }
  // IPluginBase
  tresult PLUGIN_API initialize(FUnknown*) override { return kResultOk; }
  tresult PLUGIN_API terminate() override { return kResultOk; }
  // IComponent
  tresult PLUGIN_API getControllerClassId(TUID) override { return kResultFalse; }
  tresult PLUGIN_API setIoMode(IoMode) override { return kResultOk; }
  int32 PLUGIN_API getBusCount(MediaType type, BusDirection dir) override { return type != kAudio ? 0 : dir == kInput && duck_ ? 2 : 1; }
  tresult PLUGIN_API getBusInfo(MediaType type, BusDirection dir, int32 index, BusInfo& bus) override {
    if (type != kAudio || index < 0 || index >= getBusCount(type, dir)) return kResultFalse;
    bus.mediaType = kAudio;
    bus.direction = dir;
    bus.channelCount = 2;
    daw3::v3::toString128(dir == kInput ? (index ? "Sidechain" : "In") : "Out", bus.name);
    bus.busType = index ? kAux : kMain;
    bus.flags = index ? 0 : BusInfo::kDefaultActive;
    return kResultOk;
  }
  tresult PLUGIN_API getRoutingInfo(RoutingInfo&, RoutingInfo&) override { return kNotImplemented; }
  tresult PLUGIN_API activateBus(MediaType type, BusDirection dir, int32 index, TBool state) override {
    if (type == kAudio && dir == kInput && index == 1) auxActive_ = state;
    return kResultOk;
  }
  tresult PLUGIN_API setActive(TBool) override { return kResultOk; }
  tresult PLUGIN_API setState(IBStream* s) override {
    float v;
    int32 got = 0;
    if (!s || s->read(&v, sizeof v, &got) != kResultOk || got != (int32)sizeof v) return kResultFalse;
    gain_ = v;
    return kResultOk;
  }
  tresult PLUGIN_API getState(IBStream* s) override { float v = (float)gain_.load(); return s ? s->write(&v, sizeof v, nullptr) : kInvalidArgument; }
  // IAudioProcessor
  tresult PLUGIN_API setBusArrangements(SpeakerArrangement*, int32, SpeakerArrangement*, int32) override { return kResultOk; }
  tresult PLUGIN_API getBusArrangement(BusDirection, int32, SpeakerArrangement& arr) override { arr = SpeakerArr::kStereo; return kResultOk; }
  tresult PLUGIN_API canProcessSampleSize(int32 s) override { return s == kSample32 ? kResultTrue : kResultFalse; }
  uint32 PLUGIN_API getLatencySamples() override { return 32; }
  tresult PLUGIN_API setupProcessing(ProcessSetup&) override { return kResultOk; }
  tresult PLUGIN_API setProcessing(TBool) override { return kResultOk; }
  tresult PLUGIN_API process(ProcessData& d) override {
    // sample-accurate gain: the points of the gain queue split the block
    IParamValueQueue* gq = nullptr;
    if (d.inputParameterChanges) {
      for (int32 i = 0; i < d.inputParameterChanges->getParameterCount(); i++) {
        IParamValueQueue* q = d.inputParameterChanges->getParameterData(i);
        if (!q) continue;
        int32 off;
        ParamValue v;
        if (q->getParameterId() == 0) gq = q;
        else if (q->getParameterId() == 1 && q->getPointCount() > 0 && q->getPoint(q->getPointCount() - 1, off, v) == kResultOk) selectProgram(v);
      }
    }
    if (d.numInputs < 1 || d.numOutputs < 1) return kResultOk;
    const AudioBusBuffers* key = duck_ && d.numInputs > 1 && auxActive_ ? &d.inputs[1] : nullptr;
    int32 qi = 0;
    const int32 qn = gq ? gq->getPointCount() : 0;
    for (int32 i = 0; i < d.numSamples; i++) {
      while (qi < qn) {
        int32 off;
        ParamValue v;
        if (gq->getPoint(qi, off, v) != kResultOk || off > i) break;
        gain_ = v;
        qi++;
      }
      float g = (float)(2.0 * gain_.load());
      if (key && key->numChannels > 0) g *= 1.f - std::min(1.f, std::fabs(key->channelBuffers32[0][i]));
      for (int32 c = 0; c < d.outputs[0].numChannels; c++) {
        const float* in = c < d.inputs[0].numChannels ? d.inputs[0].channelBuffers32[c] : nullptr;
        d.outputs[0].channelBuffers32[c][i] = in ? in[i] * g : 0.f;
      }
    }
    return kResultOk;
  }
  uint32 PLUGIN_API getTailSamples() override { return 0; }
  // IEditController
  tresult PLUGIN_API setComponentState(IBStream* s) override { return setState(s); }
  int32 PLUGIN_API getParameterCount() override { return 2; }
  tresult PLUGIN_API getParameterInfo(int32 i, ParameterInfo& info) override {
    if (i < 0 || i > 1) return kResultFalse;
    std::memset(&info, 0, sizeof info);
    info.id = i;
    info.unitId = kRootUnitId;
    if (i == 0) {
      daw3::v3::toString128("Gain", info.title);
      daw3::v3::toString128("Gain", info.shortTitle);
      daw3::v3::toString128("x", info.units);
      info.defaultNormalizedValue = 0.5;
      info.flags = ParameterInfo::kCanAutomate;
    } else {
      daw3::v3::toString128("Program", info.title);
      daw3::v3::toString128("Prg", info.shortTitle);
      info.stepCount = kPrograms - 1;
      info.flags = ParameterInfo::kIsProgramChange | ParameterInfo::kIsList;
    }
    return kResultOk;
  }
  tresult PLUGIN_API getParamStringByValue(ParamID, ParamValue v, String128 s) override {
    char b[32];
    snprintf(b, sizeof b, "%.2f", 2 * v);
    daw3::v3::toString128(b, s);
    return kResultOk;
  }
  tresult PLUGIN_API getParamValueByString(ParamID, TChar*, ParamValue&) override { return kResultFalse; }
  ParamValue PLUGIN_API normalizedParamToPlain(ParamID, ParamValue v) override { return 2 * v; }
  ParamValue PLUGIN_API plainParamToNormalized(ParamID, ParamValue v) override { return v / 2; }
  ParamValue PLUGIN_API getParamNormalized(ParamID id) override { return id == 0 ? gain_.load() : id == 1 ? program_ / double(kPrograms - 1) : 0; }
  tresult PLUGIN_API setParamNormalized(ParamID id, ParamValue v) override {
    if (id == 0) { gain_ = v; return kResultOk; }
    if (id == 1) { selectProgram(v); return kResultOk; }
    return kResultFalse;
  }
  tresult PLUGIN_API setComponentHandler(IComponentHandler*) override { return kResultOk; }
  IPlugView* PLUGIN_API createView(FIDString) override { return nullptr; }
  // IUnitInfo: one root unit with one program list
  int32 PLUGIN_API getUnitCount() override { return 1; }
  tresult PLUGIN_API getUnitInfo(int32 i, UnitInfo& info) override {
    if (i != 0) return kResultFalse;
    info.id = kRootUnitId;
    info.parentUnitId = kNoParentUnitId;
    daw3::v3::toString128("Root", info.name);
    info.programListId = kListId;
    return kResultOk;
  }
  int32 PLUGIN_API getProgramListCount() override { return 1; }
  tresult PLUGIN_API getProgramListInfo(int32 i, ProgramListInfo& info) override {
    if (i != 0) return kResultFalse;
    info.id = kListId;
    daw3::v3::toString128("Factory", info.name);
    info.programCount = kPrograms;
    return kResultOk;
  }
  tresult PLUGIN_API getProgramName(ProgramListID list, int32 k, String128 name) override {
    if (list != kListId || k < 0 || k >= kPrograms) return kResultFalse;
    daw3::v3::toString128(kProgramNames[k], name);
    return kResultOk;
  }
  tresult PLUGIN_API getProgramInfo(ProgramListID, int32, Steinberg::Vst::CString, String128) override { return kResultFalse; }
  tresult PLUGIN_API hasProgramPitchNames(ProgramListID, int32) override { return kResultFalse; }
  tresult PLUGIN_API getProgramPitchName(ProgramListID, int32, int16, String128) override { return kResultFalse; }
  UnitID PLUGIN_API getSelectedUnit() override { return kRootUnitId; }
  tresult PLUGIN_API selectUnit(UnitID) override { return kResultOk; }
  tresult PLUGIN_API getUnitByBus(MediaType, BusDirection, int32, int32, UnitID& u) override { u = kRootUnitId; return kResultOk; }
  tresult PLUGIN_API setUnitProgramData(int32, int32, IBStream*) override { return kNotImplemented; }

 private:
  void selectProgram(ParamValue v) {
    const int k = std::clamp((int)std::lround(v * (kPrograms - 1)), 0, kPrograms - 1);
    program_ = k;
    gain_ = kProgramGain[k];
  }
  const bool duck_;
  bool auxActive_ = false;
  std::atomic<double> gain_{0.5};
  int program_ = 0;
};

class Factory : public IPluginFactory {
 public:
  D3_REFCOUNT_STATIC
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override { return Query<Factory, IPluginFactory>::run(this, iid, obj); }
  tresult PLUGIN_API getFactoryInfo(PFactoryInfo* info) override {
    std::memset((void*)info, 0, sizeof *info);
    std::strcpy(info->vendor, "daW3");
    std::strcpy(info->url, "https://github.com/Coral-coder/daw3");
    info->flags = PFactoryInfo::kUnicode;
    return kResultOk;
  }
  int32 PLUGIN_API countClasses() override { return 2; }
  tresult PLUGIN_API getClassInfo(int32 i, PClassInfo* info) override {
    if (i < 0 || i > 1) return kResultFalse;
    std::memset((void*)info, 0, sizeof *info);
    std::memcpy(info->cid, i ? kDuckCid : kGainCid, sizeof(TUID));
    info->cardinality = PClassInfo::kManyInstances;
    std::strcpy(info->category, kVstAudioEffectClass);
    std::strcpy(info->name, i ? "daW3 Test Duck (VST3)" : "daW3 Test Gain (VST3)");
    return kResultOk;
  }
  tresult PLUGIN_API createInstance(FIDString cid, FIDString iid, void** obj) override {
    const bool gain = FUnknownPrivate::iidEqual(cid, kGainCid), duck = FUnknownPrivate::iidEqual(cid, kDuckCid);
    if (!gain && !duck) { *obj = nullptr; return kResultFalse; }
    Gain* g = new Gain(duck);
    tresult r = g->queryInterface(iid, obj);
    g->release();
    return r;
  }
};

static Factory gFactory;

extern "C" {
SMTG_EXPORT_SYMBOL IPluginFactory* PLUGIN_API GetPluginFactory() { return &gFactory; }
#ifdef __APPLE__
SMTG_EXPORT_SYMBOL bool bundleEntry(CFBundleRef) { return true; }
SMTG_EXPORT_SYMBOL bool bundleExit() { return true; }
#elif defined(_WIN32)
SMTG_EXPORT_SYMBOL bool InitDll() { return true; }
SMTG_EXPORT_SYMBOL bool ExitDll() { return true; }
#else
SMTG_EXPORT_SYMBOL bool ModuleEntry(void*) { return true; }
SMTG_EXPORT_SYMBOL bool ModuleExit() { return true; }
#endif
}
