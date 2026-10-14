// Test VST3 plugin built in CI on the MIT VST3 pluginterfaces only: "daW3 Test Gain (VST3)".
// One component that is also its own edit controller. Param 0 "Gain" (normalized; gain = 2 * value,
// default 0.5 = unity), 32 samples latency, state = the normalized gain as a float.
#include <atomic>
#include <cstring>

#include "../src/host/vst3_common.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/vstspeaker.h"

#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#endif

namespace Steinberg {
namespace Vst {
DEF_CLASS_IID(IComponent)
DEF_CLASS_IID(IAudioProcessor)
DEF_CLASS_IID(IEditController)
}  // namespace Vst
}  // namespace Steinberg

using namespace Steinberg;
using namespace Steinberg::Vst;
using daw3::v3::Query;

static const TUID kGainCid = INLINE_UID(0xD3A00001, 0x7E57AB1E, 0x0000CAFE, 0x00000001);

class Gain : public IComponent, public IAudioProcessor, public IEditController {
 public:
  D3_REFCOUNT_DELETE
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(iid, IPluginBase::iid)) { *obj = static_cast<IComponent*>(this); addRef(); return kResultOk; }
    return Query<Gain, IComponent, IAudioProcessor, IEditController>::run(this, iid, obj);
  }
  // IPluginBase
  tresult PLUGIN_API initialize(FUnknown*) override { return kResultOk; }
  tresult PLUGIN_API terminate() override { return kResultOk; }
  // IComponent
  tresult PLUGIN_API getControllerClassId(TUID) override { return kResultFalse; }
  tresult PLUGIN_API setIoMode(IoMode) override { return kResultOk; }
  int32 PLUGIN_API getBusCount(MediaType type, BusDirection) override { return type == kAudio ? 1 : 0; }
  tresult PLUGIN_API getBusInfo(MediaType type, BusDirection dir, int32 index, BusInfo& bus) override {
    if (type != kAudio || index != 0) return kResultFalse;
    bus.mediaType = kAudio;
    bus.direction = dir;
    bus.channelCount = 2;
    daw3::v3::toString128(dir == kInput ? "In" : "Out", bus.name);
    bus.busType = kMain;
    bus.flags = BusInfo::kDefaultActive;
    return kResultOk;
  }
  tresult PLUGIN_API getRoutingInfo(RoutingInfo&, RoutingInfo&) override { return kNotImplemented; }
  tresult PLUGIN_API activateBus(MediaType, BusDirection, int32, TBool) override { return kResultOk; }
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
    if (d.inputParameterChanges) {
      for (int32 i = 0; i < d.inputParameterChanges->getParameterCount(); i++) {
        IParamValueQueue* q = d.inputParameterChanges->getParameterData(i);
        int32 off;
        ParamValue v;
        if (q && q->getParameterId() == 0 && q->getPointCount() > 0 && q->getPoint(q->getPointCount() - 1, off, v) == kResultOk) gain_ = v;
      }
    }
    if (d.numInputs < 1 || d.numOutputs < 1) return kResultOk;
    const float g = (float)(2.0 * gain_.load());
    for (int32 c = 0; c < d.outputs[0].numChannels; c++) {
      const float* in = c < d.inputs[0].numChannels ? d.inputs[0].channelBuffers32[c] : nullptr;
      float* out = d.outputs[0].channelBuffers32[c];
      for (int32 i = 0; i < d.numSamples; i++) out[i] = in ? in[i] * g : 0.f;
    }
    return kResultOk;
  }
  uint32 PLUGIN_API getTailSamples() override { return 0; }
  // IEditController
  tresult PLUGIN_API setComponentState(IBStream* s) override { return setState(s); }
  tresult PLUGIN_API getParameterCount() override { return 1; }
  tresult PLUGIN_API getParameterInfo(int32 i, ParameterInfo& info) override {
    if (i != 0) return kResultFalse;
    std::memset(&info, 0, sizeof info);
    info.id = 0;
    daw3::v3::toString128("Gain", info.title);
    daw3::v3::toString128("Gain", info.shortTitle);
    daw3::v3::toString128("x", info.units);
    info.defaultNormalizedValue = 0.5;
    info.flags = ParameterInfo::kCanAutomate;
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
  ParamValue PLUGIN_API getParamNormalized(ParamID id) override { return id == 0 ? gain_.load() : 0; }
  tresult PLUGIN_API setParamNormalized(ParamID id, ParamValue v) override { if (id) return kResultFalse; gain_ = v; return kResultOk; }
  tresult PLUGIN_API setComponentHandler(IComponentHandler*) override { return kResultOk; }
  IPlugView* PLUGIN_API createView(FIDString) override { return nullptr; }

 private:
  std::atomic<double> gain_{0.5};
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
  int32 PLUGIN_API countClasses() override { return 1; }
  tresult PLUGIN_API getClassInfo(int32 i, PClassInfo* info) override {
    if (i != 0) return kResultFalse;
    std::memset((void*)info, 0, sizeof *info);
    std::memcpy(info->cid, kGainCid, sizeof(TUID));
    info->cardinality = PClassInfo::kManyInstances;
    std::strcpy(info->category, kVstAudioEffectClass);
    std::strcpy(info->name, "daW3 Test Gain (VST3)");
    return kResultOk;
  }
  tresult PLUGIN_API createInstance(FIDString cid, FIDString iid, void** obj) override {
    if (!FUnknownPrivate::iidEqual(cid, kGainCid)) { *obj = nullptr; return kResultFalse; }
    Gain* g = new Gain();
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
#else
SMTG_EXPORT_SYMBOL bool ModuleEntry(void*) { return true; }
SMTG_EXPORT_SYMBOL bool ModuleExit() { return true; }
#endif
}
