// Format-agnostic plugin model shared by the CLAP, VST3 and AU hosts.
#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "json.h"

namespace daw3 {

/** One audio bus (CLAP port / VST3 bus / AU element). */
struct AudioBus {
  std::string name;
  int channels = 2;
};

struct PluginDesc {
  std::string format;  // "clap" | "vst3" | "au"
  std::string uid;     // format-specific id (clap id, vst3 class id hex, au "type:subtype:manu")
  std::string name, vendor, version, category, path;
  bool instrument = false;
  int numInputs = 2, numOutputs = 2;  // main bus channels
  int sidechainChannels = 0;          // aux input bus (sidechain key), 0 = none
  std::vector<AudioBus> outputBuses;  // every output bus, main first (filled once the plugin is created)
  bool midiInput = false;
  std::string key() const { return format + ":" + uid; }
  /** Output channels over all buses (ProcessBlock::out holds them bus after bus). */
  int totalOutputs() const {
    if (outputBuses.empty()) return numOutputs;
    int n = 0;
    for (auto& b : outputBuses) n += b.channels;
    return n;
  }
  Json toJson() const;
};

/** A preset the plugin offers: built in ("factory") or a preset file on disk ("file"). */
struct PresetInfo {
  std::string id;        // what loadPreset() takes back
  std::string name, category;
  std::string kind;      // "factory" | "file"
  std::string path;      // preset file (kind "file")
  Json toJson() const;
};

enum ParamFlags : uint32_t { kParamAutomatable = 1, kParamStepped = 2, kParamHidden = 4, kParamReadOnly = 8, kParamBypass = 16 };

struct ParamInfo {
  uint32_t id = 0;
  std::string name, module, unit;
  double min = 0, max = 1, def = 0;
  int steps = 0;  // > 0: stepped / enum
  uint32_t flags = kParamAutomatable;
  Json toJson() const;
};

struct MidiEvt { uint32_t offset; uint8_t data[3]; };
struct ParamEvt { uint32_t offset; uint32_t id; double value; };

struct ProcessBlock {
  uint32_t nframes = 0;
  uint32_t numIn = 0, numOut = 0;
  const float* const* in = nullptr;  // planar, main input bus
  float* const* out = nullptr;       // planar, every output bus one after the other (desc().outputBuses)
  const float* const* sc = nullptr;  // planar sidechain (aux input bus) channels, may be null
  uint32_t numSc = 0;
  const MidiEvt* midi = nullptr;
  uint32_t midiCount = 0;
  const ParamEvt* params = nullptr;  // plain values
  uint32_t paramCount = 0;
  std::vector<ParamEvt>* outParams = nullptr;  // changes the plugin made (plain values)
  bool playing = false;
  double tempo = 120, ppqPos = 0;
};

/** Host-side callbacks a plugin instance may fire (any thread; implementations must be thread-safe). */
struct InstanceListener {
  std::function<void(uint32_t id, double value)> paramChanged;  // from the plugin's own GUI
  std::function<void()> latencyChanged;
  std::function<void()> paramsRescanned;
  std::function<void()> editorClosed;
};

class PluginInstance {
 public:
  virtual ~PluginInstance() = default;
  virtual const PluginDesc& desc() const = 0;
  /** Main thread. Prepares for processing (sampleRate, max block size). */
  virtual bool activate(double sampleRate, uint32_t maxFrames, std::string& err) = 0;
  virtual void deactivate() = 0;
  /** Audio thread. */
  virtual void process(ProcessBlock& b) = 0;
  virtual std::vector<ParamInfo> params() = 0;
  virtual double getParam(uint32_t id) = 0;
  /** Any thread: applied on the next process() (and to the editor). Plain value. */
  virtual void setParam(uint32_t id, double value) = 0;
  virtual bool getState(std::vector<uint8_t>& out) = 0;
  virtual bool setState(const std::vector<uint8_t>& in) = 0;
  virtual uint32_t latency() = 0;
  virtual uint32_t tailSamples() { return 0; }
  virtual bool supportsOffline() { return true; }
  virtual void setOffline(bool) {}
  virtual bool hasEditor() = 0;
  virtual bool openEditor(std::string& err) = 0;
  virtual void closeEditor() = 0;
  /** Main thread. Factory presets + preset files found for this plugin. */
  virtual std::vector<PresetInfo> presets() { return {}; }
  /** Main thread, audio thread idle (the host holds the instance lock). */
  virtual bool loadPreset(const std::string& id, std::string& err) { err = "This plugin has no presets"; return false; }
  /** Write the current state as a preset file in the format's own format (.vstpreset / .aupreset). */
  virtual bool savePreset(const std::string& path, std::string& err) { err = "Saving presets is not supported for this format"; return false; }
  void setListener(InstanceListener l) { std::lock_guard<std::mutex> g(lm_); listener_ = std::move(l); }

 protected:
  InstanceListener listener() { std::lock_guard<std::mutex> g(lm_); return listener_; }
  std::mutex lm_;
  InstanceListener listener_;
};

class PluginFormat {
 public:
  virtual ~PluginFormat() = default;
  virtual std::string name() const = 0;
  /** Default system + user folders for this format. */
  virtual std::vector<std::string> defaultPaths() const = 0;
  /** Bundle paths below `dirs` (no loading). */
  virtual std::vector<std::string> findBundles(const std::vector<std::string>& dirs) const;
  /** Load one bundle and describe the plugins inside (may crash on a bad plugin: run in the scanner process). */
  virtual bool describe(const std::string& path, std::vector<PluginDesc>& out, std::string& err) = 0;
  virtual std::unique_ptr<PluginInstance> create(const PluginDesc& d, std::string& err) = 0;
  virtual std::string bundleExtension() const = 0;
};

std::unique_ptr<PluginFormat> makeClapFormat();
std::unique_ptr<PluginFormat> makeVst3Format();
std::unique_ptr<PluginFormat> makeAuFormat();  // null on non-Apple platforms

// helpers (plugin.cpp)
std::string homeDir();
bool isDirectory(const std::string& p);
std::vector<std::string> listDir(const std::string& p);
std::string baseName(const std::string& p);
std::string stripExt(const std::string& s);
/** Folders that hold preset files of a plugin: <root>/<vendor>/<plugin name> for every preset root
 *  (macOS ~/Library/Audio/Presets + /Library/Audio/Presets, Linux ~/.vst3/presets, plus $DAW3_PRESET_DIRS). */
std::vector<std::string> presetFolders(const PluginDesc& d);
/** Preset files with extension `ext` (".vstpreset") below `dirs` -> {path, category (sub folder)}. */
std::vector<std::pair<std::string, std::string>> findPresetFiles(const std::vector<std::string>& dirs, const std::string& ext);
bool readFile(const std::string& path, std::vector<uint8_t>& out);
bool writeFile(const std::string& path, const std::vector<uint8_t>& data);
/** The executable inside a bundle: Contents/MacOS/<name> on macOS, Contents/<arch>-linux/<name>.so on Linux, or the path itself. */
std::string bundleBinary(const std::string& bundle, const std::string& ext);

// GUI glue (gui_mac.mm on macOS, gui_stub.cpp elsewhere). All on the main thread.
void* guiCreateWindow(const std::string& title, int w, int h, bool resizable, std::function<void()> onClose);
void* guiWindowView(void* win);  // NSView*
void guiResizeWindow(void* win, int w, int h);
void guiCloseWindow(void* win);
bool guiAvailable();
/** Run `fn` on the main thread (the GUI thread). */
void runOnMain(std::function<void()> fn);
/** Main loop: on macOS the Cocoa run loop; elsewhere a simple task queue. Returns when guiQuit() is called. */
void guiRunMainLoop();
void guiQuit();

}  // namespace daw3
