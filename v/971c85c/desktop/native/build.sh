#!/bin/sh
# Builds daW³'s native layer into desktop/native/build/:
#   daw3_audio.node  N-API addon (device I/O + plugin-host client), loaded by the app's audio server
#   daw3-plughost    out-of-process plugin host (CLAP / VST3 / AU)
#   daw3-link        Ableton Link as a separate process (JSON lines; desktop/link-server.cjs serves it to the app)
#   native_tests     C++ unit tests        test plugins: daW3TestGain.clap, daW3TestGain.vst3
# macOS: universal (arm64 + x86_64) unless ARCHS is set, e.g. ARCHS="arm64". Linux: ALSA / PulseAudio / JACK
# (loaded at runtime), no plugin editors / AU. Windows: MinGW-w64 g++ (MSYS2 UCRT64 / CLANGARM64 shell, or a
# cross compiler: DAW3_TARGET=win CXX=x86_64-w64-mingw32-g++-posix CC=x86_64-w64-mingw32-gcc-posix), WASAPI,
# binaries get .exe, fully static (no MinGW DLLs to ship). Usage: sh desktop/native/build.sh [--test]
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
# Git Bash / MSYS on Windows: hand the native compiler D:/… paths, not /d/… (no MSYS path conversion surprises)
case "$(uname -s)" in MINGW*|MSYS*) HERE="$(cd "$HERE" && pwd -W)" ;; esac
cd "$HERE"
sh third_party/fetch.sh >/dev/null
OUT="${DAW3_BUILD_DIR:-$HERE/build}"
OBJ="$OUT/obj"
mkdir -p "$OBJ"
OS="$(uname -s)"
case "$OS" in MINGW*|MSYS*|CYGWIN*) OS=Windows ;; esac
[ "${DAW3_TARGET:-}" = "win" ] && OS=Windows
CXX="${CXX:-c++}"
CC="${CC:-cc}"
EXE=""
[ "$OS" = "Windows" ] && EXE=".exe"
NODE_INC="${NODE_INCLUDE:-$(node -p "require('path').resolve(process.execPath, '../../include/node')")}"
if [ ! -f "$NODE_INC/node_api.h" ]; then
  # Windows Node installs ship no headers: fetch the matching headers tarball once (N-API is ABI-stable)
  NV="$(node -p process.version)"
  HDR="$HERE/third_party/node-headers"
  if [ ! -f "$HDR/node-$NV/include/node/node_api.h" ]; then
    mkdir -p "$HDR"
    curl -fsSL "https://nodejs.org/dist/$NV/node-$NV-headers.tar.gz" -o "$HDR/headers.tar.gz"
    (cd "$HDR" && tar -xzf headers.tar.gz)  # relative: GNU tar reads "D:/…" as host:path
  fi
  NODE_INC="$HDR/node-$NV/include/node"
fi
[ -f "$NODE_INC/node_api.h" ] || { echo "node_api.h not found in $NODE_INC (set NODE_INCLUDE)" >&2; exit 1; }

INC="-I$HERE/src -I$HERE/third_party/miniaudio -I$HERE/third_party/clap/include -I$HERE/third_party/vst3"
COMMON="-O2 -g0 -fPIC -fvisibility=hidden -Wall -Wno-unused-parameter -Wno-unused-function -Wno-deprecated-declarations -Wno-delete-non-virtual-dtor"
CXXSTD="-std=c++17"
if [ "$OS" = "Darwin" ]; then
  ARCHS="${ARCHS:-arm64 x86_64}"
  ARCHFLAGS=""
  for a in $ARCHS; do ARCHFLAGS="$ARCHFLAGS -arch $a"; done
  COMMON="$COMMON $ARCHFLAGS -mmacosx-version-min=11.0"
  AUDIO_LIBS="-framework CoreFoundation -framework CoreAudio -framework AudioToolbox"
  HOST_LIBS="-framework Cocoa -framework CoreFoundation -framework AudioToolbox -framework AudioUnit -framework CoreAudioKit -framework CoreAudio"
  SHARED="-bundle -undefined dynamic_lookup"
  PLUG_SHARED="-bundle"
  HOST_PLATFORM_SRC="src/host/gui_mac.mm src/host/au_host.mm"
elif [ "$OS" = "Windows" ]; then
  COMMON="$(echo "$COMMON" | sed 's/-fPIC//') -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 -DUNICODE -D_UNICODE -D_USE_MATH_DEFINES"
  STATIC="-static -static-libgcc -static-libstdc++"
  AUDIO_LIBS="$STATIC -lole32 -lwinmm -luuid -lavrt"
  HOST_LIBS="$STATIC -lole32 -lshell32 -luuid"
  SHARED="-shared"
  PLUG_SHARED="-shared"
  HOST_PLATFORM_SRC="src/host/gui_stub.cpp src/host/au_stub.cpp"
else
  AUDIO_LIBS="-ldl -lpthread -lm"
  HOST_LIBS="-ldl -lpthread"
  SHARED="-shared"
  PLUG_SHARED="-shared"
  HOST_PLATFORM_SRC="src/host/gui_stub.cpp src/host/au_stub.cpp"
fi

obj() { # obj <src> -> object path (rebuilt when the source or a header is newer)
  src="$1"
  o="$OBJ/$(echo "$src" | tr '/.' '__').o"
  if [ ! -f "$o" ] || [ -n "$(find "$HERE/src" "$HERE/testplugins" "$HERE/test" "$src" -newer "$o" -name '*.[ch]*' 2>/dev/null | head -1)" ]; then
    case "$src" in
      *.c) $CC $(echo "$COMMON" | sed "s/-Wno-delete-non-virtual-dtor//") $INC -c "$src" -o "$o" || exit 1 ;;
      *.mm) $CXX $CXXSTD $COMMON -fobjc-arc $INC -c "$src" -o "$o" || exit 1 ;;
      *) $CXX $CXXSTD $COMMON $INC -c "$src" -o "$o" || exit 1 ;;
    esac
  fi
  echo "$o"
}

echo "[native] miniaudio + engine"
MA="$(obj src/miniaudio_impl.c)"
ENG="$(obj src/audio_engine.cpp)"
echo "[native] addon"
$CXX $CXXSTD $COMMON $INC -I"$NODE_INC" -DNODE_GYP_MODULE_NAME=daw3_audio -DBUILDING_NODE_EXTENSION -c src/addon.cpp -o "$OBJ/addon.o"
$CXX $COMMON $SHARED -o "$OUT/daw3_audio.node" "$OBJ/addon.o" "$ENG" "$MA" $AUDIO_LIBS

echo "[native] plugin host"
V1="$(obj third_party/vst3/pluginterfaces/base/funknown.cpp)"
V2="$(obj third_party/vst3/pluginterfaces/base/coreiids.cpp)"
VST3_BASE="$V1 $V2"
HOSTOBJS=""
for s in src/host/plugin.cpp src/host/clap_host.cpp src/host/vst3_host.cpp $HOST_PLATFORM_SRC; do o="$(obj "$s")"; HOSTOBJS="$HOSTOBJS $o"; done
HMAIN="$(obj src/host/host_main.cpp)"
$CXX $COMMON -o "$OUT/daw3-plughost$EXE" "$HMAIN" $HOSTOBJS $VST3_BASE $HOST_LIBS

echo "[native] Ableton Link process (GPL-2.0-or-later Link SDK, see third_party/fetch.sh)"
LINK_INC="-I$HERE/third_party/link/include -I$HERE/third_party/link/modules/asio-standalone/asio/include"
if [ "$OS" = "Darwin" ]; then LINK_DEFS="-DLINK_PLATFORM_MACOSX=1 -DLINK_PLATFORM_UNIX=1"; LINK_LIBS=""
elif [ "$OS" = "Windows" ]; then LINK_DEFS="-DLINK_PLATFORM_WINDOWS=1 -D_WINSOCK_DEPRECATED_NO_WARNINGS -include pthread.h"; LINK_LIBS="$STATIC -lws2_32 -liphlpapi -lwinmm -lmswsock -lpthread"
else LINK_DEFS="-DLINK_PLATFORM_LINUX=1 -DLINK_PLATFORM_UNIX=1"; LINK_LIBS="-lpthread -latomic"; fi
LO="$OBJ/link_main.o"
if [ ! -f "$LO" ] || [ src/link/link_main.cpp -nt "$LO" ] || [ src/host/json.h -nt "$LO" ]; then
  $CXX $CXXSTD $COMMON -Wno-unused-variable -Wno-multichar $LINK_DEFS $LINK_INC -c src/link/link_main.cpp -o "$LO"
fi
$CXX $COMMON -o "$OUT/daw3-link$EXE" "$LO" $LINK_LIBS

echo "[native] test plugins"
bundle() { # bundle <name> <ext> <object files...>
  name="$1"; ext="$2"; shift 2
  b="$OUT/$name.$ext"
  rm -rf "$b"
  if [ "$OS" = "Darwin" ]; then
    mkdir -p "$b/Contents/MacOS"
    $CXX $COMMON $PLUG_SHARED -o "$b/Contents/MacOS/$name" "$@" -framework CoreFoundation
    cat > "$b/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>$name</string>
<key>CFBundleIdentifier</key><string>com.coralcoder.daw3.test.$ext</string>
<key>CFBundleName</key><string>$name</string>
<key>CFBundlePackageType</key><string>BNDL</string>
<key>CFBundleVersion</key><string>1.0.0</string>
</dict></plist>
PLIST
  elif [ "$OS" = "Windows" ] && [ "$ext" = "vst3" ]; then
    case "$($CXX -dumpmachine)" in aarch64*|arm64*) arch="arm64-win" ;; *) arch="x86_64-win" ;; esac
    mkdir -p "$b/Contents/$arch"
    $CXX $COMMON $PLUG_SHARED -o "$b/Contents/$arch/$name.vst3" "$@" $STATIC -lole32
  elif [ "$OS" = "Windows" ]; then
    $CXX $COMMON $PLUG_SHARED -o "$b" "$@" $STATIC
  elif [ "$ext" = "vst3" ]; then
    arch="$(uname -m)-linux"
    mkdir -p "$b/Contents/$arch"
    $CXX $COMMON $PLUG_SHARED -o "$b/Contents/$arch/$name.so" "$@"
  else
    $CXX $COMMON $PLUG_SHARED -o "$b" "$@"
  fi
}
GAIN_CLAP="$(obj testplugins/gain_clap.cpp)"
GAIN_VST3="$(obj testplugins/gain_vst3.cpp)"
bundle daW3TestGain clap "$GAIN_CLAP"
bundle daW3TestGain vst3 "$GAIN_VST3" $VST3_BASE

echo "[native] tests"
TESTOBJS="$(obj test/native_tests.cpp)"
if [ "$OS" = "Darwin" ]; then T2="$(obj test/test_au.mm)"; TESTOBJS="$TESTOBJS $T2"; fi
$CXX $COMMON -o "$OUT/native_tests$EXE" $TESTOBJS $ENG $MA $HOSTOBJS $VST3_BASE $AUDIO_LIBS $HOST_LIBS

if [ "${1:-}" = "--test" ]; then
  echo "[native] running native_tests"
  ${DAW3_RUN:-} "$OUT/native_tests$EXE" "$OUT/daW3TestGain.clap" "$OUT/daW3TestGain.vst3" "$OUT/daw3-link$EXE"
fi
echo "[native] done -> $OUT"
