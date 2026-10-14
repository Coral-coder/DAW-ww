// macOS GUI glue for plugin editors: the host runs a Cocoa app (accessory policy: no Dock icon of its
// own) and gives each editor an NSWindow; plugins attach their NSView to the window's content view.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <dispatch/dispatch.h>

#include "plugin.h"

@interface D3EditorDelegate : NSObject <NSWindowDelegate>
@property(nonatomic, assign) std::function<void()>* onClose;
@end

@implementation D3EditorDelegate
- (void)windowWillClose:(NSNotification*)n {
  if (self.onClose && *self.onClose) { auto fn = *self.onClose; delete self.onClose; self.onClose = nullptr; fn(); }
}
@end

namespace daw3 {

static void ensureApp() {
  static bool done = false;
  if (done) return;
  done = true;
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
}

void* guiCreateWindow(const std::string& title, int w, int h, bool resizable, std::function<void()> onClose) {
  ensureApp();
  NSUInteger style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable;
  if (resizable) style |= NSWindowStyleMaskResizable;
  NSWindow* win = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, w > 0 ? w : 400, h > 0 ? h : 300)
                                              styleMask:style backing:NSBackingStoreBuffered defer:NO];
  [win setReleasedWhenClosed:NO];
  [win setTitle:[NSString stringWithUTF8String:title.c_str()]];
  [win setLevel:NSFloatingWindowLevel];  // plugin editors float over the daW³ window
  D3EditorDelegate* del = [[D3EditorDelegate alloc] init];
  del.onClose = new std::function<void()>(std::move(onClose));
  [win setDelegate:del];
  objc_setAssociatedObject(win, "d3delegate", del, OBJC_ASSOCIATION_RETAIN);
  [win center];
  [win makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  return (__bridge_retained void*)win;
}

void* guiWindowView(void* w) { return (__bridge void*)[(__bridge NSWindow*)w contentView]; }

void guiResizeWindow(void* w, int width, int height) {
  NSWindow* win = (__bridge NSWindow*)w;
  [win setContentSize:NSMakeSize(width, height)];
}

void guiCloseWindow(void* w) {
  if (!w) return;
  NSWindow* win = (__bridge_transfer NSWindow*)w;
  D3EditorDelegate* del = (D3EditorDelegate*)[win delegate];
  if (del.onClose) { delete del.onClose; del.onClose = nullptr; }  // closed by the host: no callback
  [win close];
}

bool guiAvailable() { return true; }

void runOnMain(std::function<void()> fn) {
  auto* p = new std::function<void()>(std::move(fn));
  dispatch_async(dispatch_get_main_queue(), ^{ (*p)(); delete p; });
}

void guiRunMainLoop() {
  ensureApp();
  [NSApp run];
}

void guiQuit() {
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSApp stop:nil];
    NSEvent* e = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0
                                windowNumber:0 context:nil subtype:0 data1:0 data2:0];
    [NSApp postEvent:e atStart:YES];
  });
}

}  // namespace daw3
