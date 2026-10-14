// Audio Unit hosting (AudioComponent API: AU v2, and v3 units bridged by the system).
#import <AudioToolbox/AudioToolbox.h>
#import <AudioUnit/AUCocoaUIView.h>
#import <AudioUnit/AudioUnit.h>
#import <Cocoa/Cocoa.h>
#import <CoreAudioKit/CoreAudioKit.h>

#include <algorithm>
#include <mutex>

#include "plugin.h"

namespace daw3 {
namespace {

std::string fourcc(OSType t) {
  std::string s(4, ' ');
  for (int i = 0; i < 4; i++) s[i] = (char)((t >> (24 - 8 * i)) & 0xFF);
  return s;
}

OSType parseFourcc(const std::string& s) {
  OSType t = 0;
  for (int i = 0; i < 4; i++) t = (t << 8) | (uint8_t)(i < (int)s.size() ? s[i] : ' ');
  return t;
}

std::string cfString(CFStringRef s) {
  if (!s) return "";
  char buf[512];
  if (CFStringGetCString(s, buf, sizeof buf, kCFStringEncodingUTF8)) return buf;
  return "";
}

bool parseUid(const std::string& uid, AudioComponentDescription& d) {
  if (uid.size() != 14 || uid[4] != ':' || uid[9] != ':') return false;
  d = {};
  d.componentType = parseFourcc(uid.substr(0, 4));
  d.componentSubType = parseFourcc(uid.substr(5, 4));
  d.componentManufacturer = parseFourcc(uid.substr(10, 4));
  return true;
}

class AuInstance : public PluginInstance {
 public:
  AuInstance(const PluginDesc& d, AudioUnit u) : desc_(d), unit_(u) {
    isInstrument_ = desc_.instrument;
    acceptsMidi_ = desc_.midiInput;
    desc_.numInputs = isInstrument_ ? 0 : 2;
    desc_.numOutputs = 2;
    HostCallbackInfo hc = {};
    hc.hostUserData = this;
    hc.beatAndTempoProc = [](void* self, Float64* beat, Float64* tempo) -> OSStatus {
      auto* s = static_cast<AuInstance*>(self);
      if (beat) *beat = s->ppq_;
      if (tempo) *tempo = s->tempo_;
      return noErr;
    };
    hc.transportStateProc2 = [](void* self, Boolean* playing, Boolean* recording, Boolean* changed, Float64* sampleTime, Boolean* cycling,
                                Float64* cycleStart, Float64* cycleEnd) -> OSStatus {
      auto* s = static_cast<AuInstance*>(self);
      if (playing) *playing = s->playing_;
      if (recording) *recording = false;
      if (changed) *changed = false;
      if (sampleTime) *sampleTime = (Float64)s->samplePos_;
      if (cycling) *cycling = false;
      if (cycleStart) *cycleStart = 0;
      if (cycleEnd) *cycleEnd = 0;
      return noErr;
    };
    AudioUnitSetProperty(unit_, kAudioUnitProperty_HostCallbacks, kAudioUnitScope_Global, 0, &hc, sizeof hc);
    // parameter changes from the plugin's own UI
    if (AUEventListenerCreate(&AuInstance::onEvent, this, CFRunLoopGetMain(), kCFRunLoopDefaultMode, 0.03f, 0.03f, &events_) == noErr) {
      for (auto& p : params()) {
        AudioUnitEvent e = {};
        e.mEventType = kAudioUnitEvent_ParameterValueChange;
        e.mArgument.mParameter = {unit_, p.id, kAudioUnitScope_Global, 0};
        AUEventListenerAddEventType(events_, this, &e);
      }
      AudioUnitEvent e = {};
      e.mEventType = kAudioUnitEvent_PropertyChange;
      e.mArgument.mProperty = {unit_, kAudioUnitProperty_Latency, kAudioUnitScope_Global, 0};
      AUEventListenerAddEventType(events_, this, &e);
    }
  }

  ~AuInstance() override {
    closeEditor();
    if (events_) AUListenerDispose(events_);
    deactivate();
    AudioComponentInstanceDispose(unit_);
  }

  const PluginDesc& desc() const override { return desc_; }

  bool setFormat(AudioUnitScope scope, UInt32 ch) {
    AudioStreamBasicDescription f = {};
    f.mSampleRate = sr_;
    f.mFormatID = kAudioFormatLinearPCM;
    f.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved;
    f.mBytesPerPacket = 4;
    f.mFramesPerPacket = 1;
    f.mBytesPerFrame = 4;
    f.mChannelsPerFrame = ch;
    f.mBitsPerChannel = 32;
    return AudioUnitSetProperty(unit_, kAudioUnitProperty_StreamFormat, scope, 0, &f, sizeof f) == noErr;
  }

  bool activate(double sr, uint32_t maxFrames, std::string& err) override {
    deactivate();
    sr_ = sr;
    UInt32 mf = maxFrames;
    AudioUnitSetProperty(unit_, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &mf, sizeof mf);
    if (!setFormat(kAudioUnitScope_Output, 2)) {
      if (setFormat(kAudioUnitScope_Output, 1)) desc_.numOutputs = 1;
      else { err = "The Audio Unit rejected a 32-bit float stream format"; return false; }
    }
    if (!isInstrument_) {
      UInt32 inBuses = 1, sz = sizeof inBuses;
      AudioUnitGetProperty(unit_, kAudioUnitProperty_ElementCount, kAudioUnitScope_Input, 0, &inBuses, &sz);
      if (inBuses > 0) {
        if (!setFormat(kAudioUnitScope_Input, (UInt32)desc_.numOutputs)) {
          if (setFormat(kAudioUnitScope_Input, desc_.numOutputs == 2 ? 1 : 2)) desc_.numInputs = desc_.numOutputs == 2 ? 1 : 2;
        } else {
          desc_.numInputs = desc_.numOutputs;
        }
        AURenderCallbackStruct cb = {&AuInstance::renderInput, this};
        AudioUnitSetProperty(unit_, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &cb, sizeof cb);
      } else {
        desc_.numInputs = 0;
      }
    }
    OSStatus st = AudioUnitInitialize(unit_);
    if (st != noErr) { err = "AudioUnitInitialize failed (" + std::to_string((int)st) + ")"; return false; }
    initialized_ = true;
    abl_.resize(sizeof(AudioBufferList) + sizeof(AudioBuffer) * 2);
    silence_.assign(maxFrames, 0.f);
    scratch_.assign((size_t)maxFrames * 2, 0.f);
    return true;
  }

  void deactivate() override {
    if (initialized_) { AudioUnitUninitialize(unit_); initialized_ = false; }
  }

  void process(ProcessBlock& b) override {
    for (uint32_t c = 0; c < b.numOut; c++) std::memset(b.out[c], 0, sizeof(float) * b.nframes);
    if (!initialized_) return;
    tempo_ = b.tempo;
    ppq_ = b.ppqPos;
    playing_ = b.playing;
    curIn_ = b.in;
    curNumIn_ = b.numIn;
    curFrames_ = b.nframes;
    for (uint32_t i = 0; i < b.paramCount; i++)
      AudioUnitSetParameter(unit_, b.params[i].id, kAudioUnitScope_Global, 0, (AudioUnitParameterValue)b.params[i].value, std::min(b.params[i].offset, b.nframes - 1));
    if (acceptsMidi_)
      for (uint32_t i = 0; i < b.midiCount; i++)
        MusicDeviceMIDIEvent(unit_, b.midi[i].data[0], b.midi[i].data[1], b.midi[i].data[2], std::min(b.midi[i].offset, b.nframes ? b.nframes - 1 : 0));
    auto* abl = reinterpret_cast<AudioBufferList*>(abl_.data());
    const UInt32 nout = (UInt32)std::max(1, desc_.numOutputs);
    abl->mNumberBuffers = nout;
    for (UInt32 c = 0; c < nout; c++) {
      abl->mBuffers[c].mNumberChannels = 1;
      abl->mBuffers[c].mDataByteSize = b.nframes * sizeof(float);
      abl->mBuffers[c].mData = c < b.numOut ? b.out[c] : scratch_.data() + (size_t)c * silence_.size();
    }
    AudioTimeStamp ts = {};
    ts.mSampleTime = (Float64)samplePos_;
    ts.mFlags = kAudioTimeStampSampleTimeValid;
    AudioUnitRenderActionFlags flags = 0;
    if (AudioUnitRender(unit_, &flags, &ts, 0, b.nframes, abl) == noErr) {
      for (UInt32 c = 0; c < nout && c < b.numOut; c++)
        if (abl->mBuffers[c].mData != b.out[c] && abl->mBuffers[c].mData) std::memcpy(b.out[c], abl->mBuffers[c].mData, sizeof(float) * b.nframes);
      if (nout == 1 && b.numOut > 1) std::memcpy(b.out[1], b.out[0], sizeof(float) * b.nframes);
    }
    samplePos_ += b.nframes;
    curIn_ = nullptr;
  }

  std::vector<ParamInfo> params() override {
    std::vector<ParamInfo> out;
    UInt32 size = 0;
    if (AudioUnitGetPropertyInfo(unit_, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, &size, nullptr) != noErr || !size) return out;
    std::vector<AudioUnitParameterID> ids(size / sizeof(AudioUnitParameterID));
    if (AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, ids.data(), &size) != noErr) return out;
    for (auto id : ids) {
      AudioUnitParameterInfo info = {};
      UInt32 sz = sizeof info;
      if (AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterInfo, kAudioUnitScope_Global, id, &info, &sz) != noErr) continue;
      ParamInfo p;
      p.id = id;
      if ((info.flags & kAudioUnitParameterFlag_HasCFNameString) && info.cfNameString) {
        p.name = cfString(info.cfNameString);
        if (info.flags & kAudioUnitParameterFlag_CFNameRelease) CFRelease(info.cfNameString);
      } else {
        p.name = info.name;
      }
      if (p.name.empty()) p.name = "Param " + std::to_string(id);
      p.min = info.minValue;
      p.max = info.maxValue;
      p.def = info.defaultValue;
      p.flags = 0;
      if (info.flags & kAudioUnitParameterFlag_IsWritable) p.flags |= kParamAutomatable;
      else p.flags |= kParamReadOnly;
      if (info.unit == kAudioUnitParameterUnit_Indexed || info.unit == kAudioUnitParameterUnit_Boolean) {
        p.flags |= kParamStepped;
        p.steps = (int)std::max(1.f, info.maxValue - info.minValue);
      }
      static const char* units[] = {"", "", "%", "s", "samples", "", "Hz", "", "", "", "", "", "", "dB", "", "", "", "", "", "", "", "", "", "", "", "", ""};
      if (info.unit < sizeof(units) / sizeof(units[0])) p.unit = units[info.unit];
      out.push_back(p);
    }
    return out;
  }

  double getParam(uint32_t id) override {
    AudioUnitParameterValue v = 0;
    AudioUnitGetParameter(unit_, id, kAudioUnitScope_Global, 0, &v);
    return v;
  }

  void setParam(uint32_t id, double value) override {
    AudioUnitParameter p = {unit_, id, kAudioUnitScope_Global, 0};
    AUParameterSet(nullptr, nullptr, &p, (AudioUnitParameterValue)value, 0);  // also notifies the editor
  }

  bool getState(std::vector<uint8_t>& out) override {
    CFPropertyListRef plist = nullptr;
    UInt32 sz = sizeof plist;
    if (AudioUnitGetProperty(unit_, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &plist, &sz) != noErr || !plist) return false;
    CFDataRef data = CFPropertyListCreateData(nullptr, plist, kCFPropertyListBinaryFormat_v1_0, 0, nullptr);
    CFRelease(plist);
    if (!data) return false;
    out.assign(CFDataGetBytePtr(data), CFDataGetBytePtr(data) + CFDataGetLength(data));
    CFRelease(data);
    return true;
  }

  bool setState(const std::vector<uint8_t>& in) override {
    if (in.empty()) return false;
    CFDataRef data = CFDataCreate(nullptr, in.data(), (CFIndex)in.size());
    CFPropertyListRef plist = CFPropertyListCreateWithData(nullptr, data, kCFPropertyListImmutable, nullptr, nullptr);
    CFRelease(data);
    if (!plist) return false;
    OSStatus st = AudioUnitSetProperty(unit_, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &plist, sizeof plist);
    CFRelease(plist);
    if (st != noErr) return false;
    AudioUnitParameter any = {unit_, kAUParameterListener_AnyParameter, kAudioUnitScope_Global, 0};
    AUParameterListenerNotify(nullptr, nullptr, &any);
    return true;
  }

  uint32_t latency() override {
    Float64 s = 0;
    UInt32 sz = sizeof s;
    AudioUnitGetProperty(unit_, kAudioUnitProperty_Latency, kAudioUnitScope_Global, 0, &s, &sz);
    return (uint32_t)llround(s * sr_);
  }

  uint32_t tailSamples() override {
    Float64 s = 0;
    UInt32 sz = sizeof s;
    AudioUnitGetProperty(unit_, kAudioUnitProperty_TailTime, kAudioUnitScope_Global, 0, &s, &sz);
    return s > 60 ? 0 : (uint32_t)llround(s * sr_);
  }

  void setOffline(bool off) override {
    UInt32 v = off ? 1 : 0;
    AudioUnitSetProperty(unit_, kAudioUnitProperty_OfflineRender, kAudioUnitScope_Global, 0, &v, sizeof v);
  }

  bool hasEditor() override { return true; }  // a custom Cocoa view, or the generic parameter view

  bool openEditor(std::string& err) override {
    if (window_) return true;
    NSView* view = nil;
    UInt32 size = 0;
    Boolean writable = false;
    if (AudioUnitGetPropertyInfo(unit_, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, &size, &writable) == noErr && size >= sizeof(AudioUnitCocoaViewInfo)) {
      std::vector<uint8_t> buf(size);
      auto* info = reinterpret_cast<AudioUnitCocoaViewInfo*>(buf.data());
      if (AudioUnitGetProperty(unit_, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, info, &size) == noErr) {
        NSURL* url = (__bridge NSURL*)info->mCocoaAUViewBundleLocation;
        NSString* cls = (__bridge NSString*)info->mCocoaAUViewClass[0];
        NSBundle* bundle = url ? [NSBundle bundleWithURL:url] : nil;
        Class factoryClass = bundle && cls ? [bundle classNamed:cls] : nil;
        if (factoryClass && [factoryClass conformsToProtocol:@protocol(AUCocoaUIBase)]) {
          id<AUCocoaUIBase> factory = [[factoryClass alloc] init];
          view = [factory uiViewForAudioUnit:unit_ withSize:NSMakeSize(600, 400)];
        }
        if (info->mCocoaAUViewBundleLocation) CFRelease(info->mCocoaAUViewBundleLocation);
        for (UInt32 i = 0; i < (size - sizeof(CFURLRef)) / sizeof(CFStringRef); i++)
          if (info->mCocoaAUViewClass[i]) CFRelease(info->mCocoaAUViewClass[i]);
      }
    }
    if (!view) {
      AUGenericView* g = [[AUGenericView alloc] initWithAudioUnit:unit_];
      [g setShowsExpertParameters:YES];
      view = g;
    }
    if (!view) { err = "The Audio Unit has no editor"; return false; }
    NSRect r = [view frame];
    window_ = guiCreateWindow(desc_.name, (int)std::max(200.0, r.size.width), (int)std::max(80.0, r.size.height), false, [this, alive = alive_]() {
      if (!*alive) return;
      window_ = nullptr;
      view_ = nil;
      auto l = listener();
      if (l.editorClosed) l.editorClosed();
    });
    view_ = view;
    [(__bridge NSView*)guiWindowView(window_) addSubview:view];
    return true;
  }

  void closeEditor() override {
    if (view_) { [view_ removeFromSuperview]; view_ = nil; }
    if (window_) { void* w = window_; window_ = nullptr; guiCloseWindow(w); }
  }

 private:
  static OSStatus renderInput(void* self, AudioUnitRenderActionFlags*, const AudioTimeStamp*, UInt32, UInt32 frames, AudioBufferList* io) {
    auto* s = static_cast<AuInstance*>(self);
    for (UInt32 c = 0; c < io->mNumberBuffers; c++) {
      const float* src = s->curIn_ && s->curNumIn_ ? s->curIn_[std::min<uint32_t>(c, s->curNumIn_ - 1)] : s->silence_.data();
      if (!io->mBuffers[c].mData) io->mBuffers[c].mData = const_cast<float*>(src);
      else std::memcpy(io->mBuffers[c].mData, src, sizeof(float) * std::min<UInt32>(frames, (UInt32)s->silence_.size()));
    }
    return noErr;
  }

  static void onEvent(void* self, void*, const AudioUnitEvent* e, UInt64, AudioUnitParameterValue v) {
    auto* s = static_cast<AuInstance*>(self);
    auto l = s->listener();
    if (e->mEventType == kAudioUnitEvent_ParameterValueChange) { if (l.paramChanged) l.paramChanged(e->mArgument.mParameter.mParameterID, v); }
    else if (e->mEventType == kAudioUnitEvent_PropertyChange && e->mArgument.mProperty.mPropertyID == kAudioUnitProperty_Latency) { if (l.latencyChanged) l.latencyChanged(); }
  }

  PluginDesc desc_;
  AudioUnit unit_;
  AUEventListenerRef events_ = nullptr;
  bool isInstrument_ = false, acceptsMidi_ = false, initialized_ = false;
  double sr_ = 48000;
  double tempo_ = 120, ppq_ = 0;
  bool playing_ = false;
  uint64_t samplePos_ = 0;
  const float* const* curIn_ = nullptr;
  uint32_t curNumIn_ = 0, curFrames_ = 0;
  std::vector<uint8_t> abl_;
  std::vector<float> silence_, scratch_;
  void* window_ = nullptr;
  NSView* view_ = nil;
  std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

class AuFormat : public PluginFormat {
 public:
  std::string name() const override { return "au"; }
  std::string bundleExtension() const override { return ".component"; }
  std::vector<std::string> defaultPaths() const override { return {homeDir() + "/Library/Audio/Plug-Ins/Components", "/Library/Audio/Plug-Ins/Components"}; }
  // Audio Units are found through the system's component registry, not by walking folders.
  std::vector<std::string> findBundles(const std::vector<std::string>&) const override { return {"all"}; }

  bool describe(const std::string&, std::vector<PluginDesc>& out, std::string&) override {
    const OSType types[] = {kAudioUnitType_MusicDevice, kAudioUnitType_Effect, kAudioUnitType_MusicEffect};
    for (OSType type : types) {
      AudioComponentDescription want = {type, 0, 0, 0, 0};
      AudioComponent comp = nullptr;
      while ((comp = AudioComponentFindNext(comp, &want))) {
        AudioComponentDescription d;
        if (AudioComponentGetDescription(comp, &d) != noErr) continue;
        PluginDesc pd;
        pd.format = "au";
        pd.uid = fourcc(d.componentType) + ":" + fourcc(d.componentSubType) + ":" + fourcc(d.componentManufacturer);
        CFStringRef cfname = nullptr;
        std::string full;
        if (AudioComponentCopyName(comp, &cfname) == noErr && cfname) { full = cfString(cfname); CFRelease(cfname); }
        const size_t colon = full.find(": ");
        pd.vendor = colon == std::string::npos ? fourcc(d.componentManufacturer) : full.substr(0, colon);
        pd.name = colon == std::string::npos ? full : full.substr(colon + 2);
        UInt32 ver = 0;
        if (AudioComponentGetVersion(comp, &ver) == noErr) pd.version = std::to_string(ver >> 16) + "." + std::to_string((ver >> 8) & 0xFF) + "." + std::to_string(ver & 0xFF);
        pd.instrument = type == kAudioUnitType_MusicDevice;
        pd.midiInput = type != kAudioUnitType_Effect;
        pd.numInputs = pd.instrument ? 0 : 2;
        pd.numOutputs = 2;
        pd.category = pd.instrument ? "Instrument" : type == kAudioUnitType_MusicEffect ? "Music Effect" : "Effect";
        out.push_back(pd);
      }
    }
    return true;
  }

  std::unique_ptr<PluginInstance> create(const PluginDesc& d, std::string& err) override {
    AudioComponentDescription want;
    if (!parseUid(d.uid, want)) { err = "Bad Audio Unit id " + d.uid; return nullptr; }
    AudioComponent comp = AudioComponentFindNext(nullptr, &want);
    if (!comp) { err = "Audio Unit not installed: " + d.uid; return nullptr; }
    AudioUnit unit = nullptr;
    OSStatus st = AudioComponentInstanceNew(comp, &unit);
    if (st != noErr || !unit) { err = "Could not open the Audio Unit (" + std::to_string((int)st) + ")"; return nullptr; }
    PluginDesc pd = d;
    pd.instrument = want.componentType == kAudioUnitType_MusicDevice;
    pd.midiInput = want.componentType != kAudioUnitType_Effect;
    return std::make_unique<AuInstance>(pd, unit);
  }
};

}  // namespace

std::unique_ptr<PluginFormat> makeAuFormat() { return std::make_unique<AuFormat>(); }

}  // namespace daw3
