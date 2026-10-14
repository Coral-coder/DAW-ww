// daw3-link — Ableton Link for the daW³ Mac app, as a small separate process (it is GPL-2.0-or-later code:
// Ableton Link is "GPLv2 or later", daW³ is AGPL-3.0-or-later, and GPLv3 §13 / AGPLv3 §13 allow the two to
// be combined; keeping it out of the app's own process also keeps Link's network threads away from audio).
//
// Protocol: JSON lines (the same messages as tools/link-bridge, which re-publishes them on a local WebSocket)
//   stdin   {type:'tempo', bpm} | {type:'play'} | {type:'stop'} | {type:'quantum', value} | {type:'enable', on} | {type:'state'}
//   stdout  {type:'state', tempo, beat, phase, quantum, playing, peers, link:true, enabled, time}  20x/s and after
//           every change (time = wall clock ms, the same clock as JavaScript's Date.now())
//   daw3-link --version   prints the Link version line and exits
#include <ableton/Link.hpp>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <process.h>
#else
#include <unistd.h>
#endif

#include "../host/json.h"

using daw3::Json;

namespace {

std::mutex gOut;

void emit(const Json& j) {
  std::lock_guard<std::mutex> g(gOut);
  std::string s = j.dump();
  s += '\n';
  fwrite(s.data(), 1, s.size(), stdout);
  fflush(stdout);
}

double wallMs() {
  return (double)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

struct Session {
  ableton::Link link{120.0};
  std::atomic<double> quantum{4.0};

  Json state() {
    const auto t = link.clock().micros();
    auto s = link.captureAppSessionState();
    const double q = quantum.load();
    Json j = Json::object();
    j.set("type", "state").set("tempo", s.tempo()).set("beat", s.beatAtTime(t, q)).set("phase", s.phaseAtTime(t, q)).set("quantum", q)
        .set("playing", s.isPlaying()).set("peers", (double)link.numPeers()).set("link", true).set("enabled", link.isEnabled()).set("time", wallMs());
    return j;
  }

  void command(const Json& m) {
    const std::string type = m["type"].str();
    const auto t = link.clock().micros();
    if (type == "tempo") {
      const double bpm = m["bpm"].num(0);
      if (bpm >= 20 && bpm <= 999) {
        auto s = link.captureAppSessionState();
        s.setTempo(bpm, t);
        link.commitAppSessionState(s);
      }
    } else if (type == "play" || type == "stop") {
      auto s = link.captureAppSessionState();
      // start on the next quantum boundary of the shared timeline (Link's start/stop semantics)
      if (type == "play") s.setIsPlayingAndRequestBeatAtTime(true, t, 0.0, quantum.load());
      else s.setIsPlaying(false, t);
      link.commitAppSessionState(s);
    } else if (type == "quantum") {
      const double q = m["value"].num(0);
      if (q >= 1 && q <= 16) quantum.store(q);
    } else if (type == "enable") {
      link.enable(m["on"].boolean(true));
    }
  }
};

}  // namespace

int main(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdout), _O_BINARY);  // JSON lines without CRLF translation
  _setmode(_fileno(stdin), _O_BINARY);
#endif
  if (argc > 1 && std::string(argv[1]) == "--version") {
    printf("daw3-link (Ableton Link 3.1.5, GPL-2.0-or-later)\n");
    return 0;
  }
  static Session s;
  s.link.enableStartStopSync(true);
  std::atomic<bool> changed{true}, quit{false};
  s.link.setNumPeersCallback([&](std::size_t) { changed = true; });
  s.link.setTempoCallback([&](double) { changed = true; });
  s.link.setStartStopCallback([&](bool) { changed = true; });
  s.link.enable(true);
  std::thread reader([&] {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line.empty()) continue;
      bool ok = false;
      Json m = Json::parse(line, &ok);
      if (!ok) continue;
      if (m["type"].str() == "quit") break;
      s.command(m);
      changed = true;
    }
    quit = true;  // stdin closed: the app went away
  });
  emit(Json::object().set("type", "ready").set("version", "3.1.5"));
  int tick = 0;
  while (!quit.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    if (changed.exchange(false) || ++tick >= 10) {  // every change, else 20x/s
      tick = 0;
      emit(s.state());
    }
  }
  emit(s.state());  // the final state (also what a one-shot `printf … | daw3-link` sees)
  s.link.enable(false);
  reader.detach();
  fflush(stdout);
  _exit(0);
}
