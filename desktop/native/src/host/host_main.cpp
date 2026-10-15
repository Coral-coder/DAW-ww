// daw3-plughost — the out-of-process plugin host. A crashing plugin takes down only this process;
// the app notices (pipe closed / process timeout), reports it and can restart the host.
//
//   daw3-plughost --describe <clap|vst3|au> <bundle path | "all">   one JSON line describing the plugins, then exit
//   daw3-plughost --serve --shm <file> --req <fifo> --done <fifo>    control on stdin/stdout (JSON lines),
//                                                                     audio blocks through the shared memory
#include <signal.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <process.h>
#include "platform.h"
#include <shellapi.h>
#define getpid _getpid
#else
#include <unistd.h>
#endif

#include <atomic>
#include <cstdio>
#include <iostream>
#include <map>
#include <mutex>
#include <string>
#include <thread>

#include "../shm.h"
#include "plugin.h"

using namespace daw3;

namespace {

std::map<std::string, std::unique_ptr<PluginFormat>> gFormats;
std::mutex gOutM;

void emit(const Json& j) {
  std::lock_guard<std::mutex> g(gOutM);
  std::string s = j.dump();
  s += '\n';
  fwrite(s.data(), 1, s.size(), stdout);
  fflush(stdout);
}

void initFormats() {
  gFormats["clap"] = makeClapFormat();
  gFormats["vst3"] = makeVst3Format();
  if (auto au = makeAuFormat()) gFormats["au"] = std::move(au);
}

PluginFormat* format(const std::string& n) {
  auto it = gFormats.find(n);
  return it == gFormats.end() ? nullptr : it->second.get();
}

/** The CPU architecture this host process runs as (a universal binary under Rosetta reports x86_64). */
const char* hostArch() {
#if defined(__aarch64__) || defined(_M_ARM64)
  return "arm64";
#elif defined(__x86_64__) || defined(_M_X64)
  return "x86_64";
#else
  return "other";
#endif
}

int describeMain(const std::string& fmt, const std::string& path) {
  initFormats();
  Json r = Json::object();
  PluginFormat* f = format(fmt);
  if (!f) { r.set("ok", false).set("error", "Unknown plugin format " + fmt); emit(r); return 2; }
  std::vector<PluginDesc> list;
  std::string err;
  bool ok = f->describe(path, list, err);
  Json arr = Json::array();
  for (auto& d : list) arr.push(d.toJson());
  r.set("ok", ok).set("path", path).set("format", fmt).set("plugins", arr).set("hostArch", hostArch());
  if (!ok) r.set("error", err);
  emit(r);
  return ok ? 0 : 1;
}

// ------------------------------------------------------------------------------------- server
struct Server {
  ShmRegion shm;
  FifoSignal req, done;
  ShmHeader* h = nullptr;
  std::mutex instM;
  std::map<int, std::shared_ptr<PluginInstance>> insts;
  std::atomic<bool> quit{false};
  double sampleRate = 48000;

  Json instInfo(PluginInstance& p) {
    Json params = Json::array();
    Json values = Json::object();
    for (auto& pi : p.params()) {
      params.push(pi.toJson());
      values.set(std::to_string(pi.id), p.getParam(pi.id));
    }
    Json j = Json::object();
    j.set("plugin", p.desc().toJson()).set("params", params).set("values", values).set("latency", p.latency()).set("tail", p.tailSamples())
        .set("hasEditor", p.hasEditor()).set("offline", p.supportsOffline());
    return j;
  }

  std::shared_ptr<PluginInstance> get(int id) {
    std::lock_guard<std::mutex> g(instM);
    auto it = insts.find(id);
    return it == insts.end() ? nullptr : it->second;
  }

  void handle(const Json& m) {
    Json r = Json::object();
    r.set("id", m["id"]);
    const std::string cmd = m["cmd"].str();
    const int iid = (int)m["inst"].num(-1);
    std::string err;
    try {
      if (cmd == "hello") {
        Json fm = Json::array();
        for (auto& kv : gFormats) fm.push(kv.first);
        r.set("ok", true).set("formats", fm).set("gui", guiAvailable()).set("pid", (double)getpid());
      } else if (cmd == "load") {
        const Json& pj = m["plugin"];
        PluginDesc d;
        d.format = pj["format"].str();
        d.uid = pj["uid"].str();
        d.path = pj["path"].str();
        d.name = pj["name"].str(d.uid);
        d.vendor = pj["vendor"].str();
        d.instrument = pj["instrument"].boolean();
        PluginFormat* f = format(d.format);
        if (!f) throw std::runtime_error("Unsupported plugin format: " + d.format);
        auto inst = std::shared_ptr<PluginInstance>(f->create(d, err).release());
        if (!inst) throw std::runtime_error(err.empty() ? "Could not create the plugin" : err);
        if (m["state"].isString() && !m["state"].str().empty()) inst->setState(base64Decode(m["state"].str()));
        const double sr = m["sampleRate"].num(sampleRate);
        const uint32_t mf = (uint32_t)m["maxFrames"].num(h ? h->maxFrames : 1024);
        if (!inst->activate(sr, std::min<uint32_t>(mf, h ? h->maxFrames : mf), err)) throw std::runtime_error(err);
        InstanceListener l;
        l.paramChanged = [iid](uint32_t id, double v) { Json e = Json::object(); e.set("event", "param").set("inst", iid).set("param", id).set("value", v); emit(e); };
        std::weak_ptr<PluginInstance> wp = inst;
        l.latencyChanged = [iid, wp]() {
          runOnMain([iid, wp]() { if (auto p = wp.lock()) { Json e = Json::object(); e.set("event", "latency").set("inst", iid).set("samples", p->latency()); emit(e); } });
        };
        l.paramsRescanned = [iid]() { Json e = Json::object(); e.set("event", "params-changed").set("inst", iid); emit(e); };
        l.editorClosed = [iid]() { Json e = Json::object(); e.set("event", "editor-closed").set("inst", iid); emit(e); };
        inst->setListener(l);
        {
          std::lock_guard<std::mutex> g(instM);
          insts[iid] = inst;
        }
        r.set("ok", true).set("info", instInfo(*inst));
      } else if (cmd == "setSampleRate") {
        // the device rate changed: re-activate every instance at the new rate (state and parameters are kept)
        sampleRate = m["sampleRate"].num(sampleRate);
        const uint32_t mf = (uint32_t)m["maxFrames"].num(h ? h->maxFrames : 1024);
        Json lat = Json::object(), failed = Json::array();
        std::lock_guard<std::mutex> g(instM);
        for (auto& kv : insts) {
          std::string e;
          if (kv.second->activate(sampleRate, std::min<uint32_t>(mf, h ? h->maxFrames : mf), e)) lat.set(std::to_string(kv.first), kv.second->latency());
          else failed.push(Json::object().set("inst", kv.first).set("error", e));
        }
        r.set("ok", true).set("sampleRate", sampleRate).set("latency", lat).set("failed", failed);
      } else if (cmd == "unload") {
        std::shared_ptr<PluginInstance> p;
        {
          std::lock_guard<std::mutex> g(instM);
          auto it = insts.find(iid);
          if (it != insts.end()) { p = it->second; insts.erase(it); }
        }
        if (p) { p->closeEditor(); p->deactivate(); }
        r.set("ok", true);
      } else {
        auto p = get(iid);
        if (!p) throw std::runtime_error("No such plugin instance");
        if (cmd == "activate") {
          std::lock_guard<std::mutex> g(instM);
          if (!p->activate(m["sampleRate"].num(sampleRate), (uint32_t)m["maxFrames"].num(h ? h->maxFrames : 1024), err)) throw std::runtime_error(err);
          r.set("ok", true).set("latency", p->latency());
        } else if (cmd == "setParam") {
          p->setParam((uint32_t)m["param"].num(), m["value"].num());
          r.set("ok", true);
        } else if (cmd == "info") {
          r.set("ok", true).set("info", instInfo(*p));
        } else if (cmd == "getState") {
          std::vector<uint8_t> st;
          if (!p->getState(st)) throw std::runtime_error("This plugin does not save a state");
          r.set("ok", true).set("state", base64Encode(st));
        } else if (cmd == "setState") {
          bool ok;
          {
            std::lock_guard<std::mutex> g(instM);
            ok = p->setState(base64Decode(m["state"].str()));
          }
          if (!ok) throw std::runtime_error("The plugin rejected the saved state");
          r.set("ok", true).set("info", instInfo(*p));
        } else if (cmd == "openEditor") {
          if (!p->openEditor(err)) throw std::runtime_error(err);
          r.set("ok", true);
        } else if (cmd == "closeEditor") {
          p->closeEditor();
          r.set("ok", true);
        } else if (cmd == "presets") {
          Json arr = Json::array();
          for (auto& pr : p->presets()) arr.push(pr.toJson());
          r.set("ok", true).set("presets", arr);
        } else if (cmd == "loadPreset") {
          bool ok;
          {
            std::lock_guard<std::mutex> g(instM);
            ok = p->loadPreset(m["preset"].str(), err);
          }
          if (!ok) throw std::runtime_error(err.empty() ? "Could not load the preset" : err);
          r.set("ok", true).set("info", instInfo(*p));
        } else if (cmd == "savePreset") {
          if (!p->savePreset(m["path"].str(), err)) throw std::runtime_error(err);
          r.set("ok", true);
        } else if (cmd == "setOffline") {
          std::lock_guard<std::mutex> g(instM);
          p->setOffline(m["offline"].boolean());
          r.set("ok", true);
        } else {
          throw std::runtime_error("Unknown command " + cmd);
        }
      }
    } catch (const std::exception& e) {
      r.set("ok", false).set("error", e.what());
    }
    emit(r);
  }

  void audioLoop() {
    // everything up to the last answered request is done: a request posted before this thread got to run is
    // still picked up (starting from reqSeq instead would drop it and hang that block until the app times out)
    uint64_t last = h->doneSeq.load();
    std::vector<ParamEvt> outParams;
    outParams.reserve(kMaxParamEvents);
    std::vector<MidiEvt> midi(kMaxMidi);
    std::vector<ParamEvt> params(kMaxParamEvents);
    std::vector<float*> ins(h->maxChannels), outs(h->maxChannels), scs(h->maxChannels);
    while (!quit.load()) {
      if (!req.wait(250)) continue;
      const uint64_t seq = h->reqSeq.load(std::memory_order_acquire);
      if (seq == last) continue;
      last = seq;
      const uint32_t nframes = std::min(h->nframes, h->maxFrames);
      const uint32_t nin = std::min(h->numIn, h->maxChannels), nout = std::min(h->numOut, h->maxChannels);
      const uint32_t nsc = std::min(h->numSc, h->maxChannels - nin);
      for (uint32_t c = 0; c < h->maxChannels; c++) {
        ins[c] = shmIn(h) + (size_t)c * h->maxFrames;
        outs[c] = shmOut(h) + (size_t)c * h->maxFrames;
      }
      const uint32_t mc = std::min(h->midiCount, kMaxMidi), pc = std::min(h->paramCount, kMaxParamEvents);
      for (uint32_t i = 0; i < mc; i++) { midi[i].offset = h->midi[i].offset; std::memcpy(midi[i].data, h->midi[i].data, 3); }
      for (uint32_t i = 0; i < pc; i++) params[i] = {h->params[i].offset, h->params[i].id, h->params[i].value};
      outParams.clear();
      ProcessBlock b;
      b.nframes = nframes;
      b.numIn = nin;
      b.numOut = nout;
      b.in = ins.data();
      b.out = outs.data();
      for (uint32_t c = 0; c < nsc; c++) scs[c] = ins[nin + c];
      b.sc = nsc ? scs.data() : nullptr;
      b.numSc = nsc;
      b.midi = midi.data();
      b.midiCount = mc;
      b.params = params.data();
      b.paramCount = pc;
      b.outParams = &outParams;
      b.playing = h->playing != 0;
      b.tempo = h->tempo > 0 ? h->tempo : 120;
      b.ppqPos = h->ppqPos;
      uint32_t status = kShmOk;
      {
        std::lock_guard<std::mutex> g(instM);
        auto it = insts.find((int)h->instId);
        if (it == insts.end()) {
          status = kShmNoInstance;
          for (uint32_t c = 0; c < nout; c++) std::memset(outs[c], 0, sizeof(float) * nframes);
        } else {
          it->second->process(b);
        }
      }
      h->outParamCount = (uint32_t)std::min<size_t>(outParams.size(), kMaxParamEvents);
      for (uint32_t i = 0; i < h->outParamCount; i++) h->outParams[i] = {outParams[i].offset, outParams[i].id, outParams[i].value};
      h->status = status;
      h->doneSeq.store(seq, std::memory_order_release);
      done.post();
    }
  }
};

int serveMain(const std::string& shmPath, const std::string& reqPath, const std::string& donePath) {
  initFormats();
  static Server s;
  if (!s.shm.open(shmPath) || !s.req.open(reqPath) || !s.done.open(donePath)) {
    fprintf(stderr, "daw3-plughost: cannot open the shared memory / fifos\n");
    return 3;
  }
  s.h = static_cast<ShmHeader*>(s.shm.ptr());
  if (s.h->magic != kShmMagic || s.h->version != kShmVersion || shmSize(s.h->maxFrames, s.h->maxChannels) > s.shm.size()) {
    fprintf(stderr, "daw3-plughost: shared memory layout mismatch\n");
    return 3;
  }
  if (s.h->sampleRate > 0) s.sampleRate = s.h->sampleRate;
  std::thread audio([] { s.audioLoop(); });
  std::thread reader([] {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line.empty()) continue;
      bool ok = false;
      Json m = Json::parse(line, &ok);
      if (!ok) { Json e = Json::object(); e.set("event", "error").set("error", "bad json"); emit(e); continue; }
      if (m["cmd"].str() == "quit") break;
      runOnMain([m]() { s.handle(m); });
    }
    // stdin closed (the app quit or crashed) or "quit": shut down
    runOnMain([]() {
      std::vector<std::shared_ptr<PluginInstance>> all;
      {
        std::lock_guard<std::mutex> g(s.instM);
        for (auto& kv : s.insts) all.push_back(kv.second);
        s.insts.clear();
      }
      for (auto& p : all) { p->closeEditor(); p->deactivate(); }
      all.clear();
      s.quit.store(true);
      guiQuit();
    });
  });
  emit(Json::object().set("event", "ready").set("pid", (double)getpid()).set("arch", hostArch()));
  guiRunMainLoop();
  s.quit.store(true);
  audio.join();
  reader.detach();
  fflush(stdout);
  _exit(0);
}

}  // namespace

int main(int argc, char** argv) {
#ifdef _WIN32
  // JSON lines without CRLF translation; arguments (plugin paths) as UTF-8 rather than the ANSI code page
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
  std::vector<std::string> utf8Args;
  std::vector<char*> utf8Argv;
  {
    int wargc = 0;
    if (LPWSTR* wargv = CommandLineToArgvW(GetCommandLineW(), &wargc)) {
      for (int i = 0; i < wargc; i++) utf8Args.push_back(narrow(wargv[i]));
      LocalFree(wargv);
      for (auto& x : utf8Args) utf8Argv.push_back(&x[0]);
      argc = (int)utf8Argv.size();
      argv = utf8Argv.data();
    }
  }
#else
  signal(SIGPIPE, SIG_IGN);
#endif
  std::map<std::string, std::string> a;
  std::vector<std::string> pos;
  for (int i = 1; i < argc; i++) {
    std::string s = argv[i];
    if (s == "--describe" && i + 2 < argc) { a["describe"] = argv[i + 1]; a["path"] = argv[i + 2]; i += 2; }
    else if ((s == "--shm" || s == "--req" || s == "--done") && i + 1 < argc) a[s.substr(2)] = argv[++i];
    else if (s == "--serve") a["serve"] = "1";
    else pos.push_back(s);
  }
  if (a.count("describe")) return describeMain(a["describe"], a["path"]);
  if (a.count("serve")) return serveMain(a["shm"], a["req"], a["done"]);
  fprintf(stderr, "usage: daw3-plughost --describe <clap|vst3|au> <path|all> | --serve --shm F --req F --done F\n");
  return 2;
}
