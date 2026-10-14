// Non-Apple GUI glue: no plugin windows; a plain task queue stands in for the main run loop.
#include <condition_variable>
#include <deque>
#include <mutex>

#include "plugin.h"

namespace daw3 {

static std::mutex qm;
static std::condition_variable qcv;
static std::deque<std::function<void()>> q;
static bool quitting = false;

void* guiCreateWindow(const std::string&, int, int, bool, std::function<void()>) { return nullptr; }
void* guiWindowView(void*) { return nullptr; }
void guiResizeWindow(void*, int, int) {}
void guiCloseWindow(void*) {}
bool guiAvailable() { return false; }

void runOnMain(std::function<void()> fn) {
  { std::lock_guard<std::mutex> g(qm); q.push_back(std::move(fn)); }
  qcv.notify_one();
}

void guiRunMainLoop() {
  for (;;) {
    std::function<void()> fn;
    {
      std::unique_lock<std::mutex> l(qm);
      qcv.wait(l, [] { return quitting || !q.empty(); });
      if (q.empty() && quitting) return;
      fn = std::move(q.front());
      q.pop_front();
    }
    fn();
  }
}

void guiQuit() {
  { std::lock_guard<std::mutex> g(qm); quitting = true; }
  qcv.notify_all();
}

}  // namespace daw3
