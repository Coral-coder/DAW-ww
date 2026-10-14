#!/bin/sh
# Fetches the pinned, permissively licensed third-party sources the native layer builds against
# (kept out of git — they are large and versioned here instead):
#   miniaudio 0.11.22  — public domain / MIT-0 (single header; CoreAudio on macOS, null backend for tests)
#   CLAP 1.2.7         — MIT (header-only plugin ABI)
#   VST3 pluginterfaces v3.8.0 — MIT since VST 3.8 (Steinberg, 2025; see its LICENSE.txt)
# Audio Units come from the macOS system frameworks (AudioToolbox / CoreAudioKit).
set -eu
cd "$(dirname "$0")"
MINIAUDIO_SHA256=9019743287e443c55e5737a7297f38e5e358561701d6db2d905afb114390c410
CLAP_COMMIT=29ffcc273be7c7c651f6c9953b99e69700e2387a
VST3_COMMIT=31d6eeba6daaa3e2a8bfbe3e7a90ca0b7fbfbc1c

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

if [ ! -f miniaudio/miniaudio.h ] || [ "$(sha miniaudio/miniaudio.h)" != "$MINIAUDIO_SHA256" ]; then
  mkdir -p miniaudio
  curl -fsSL -o miniaudio/miniaudio.h https://raw.githubusercontent.com/mackron/miniaudio/0.11.22/miniaudio.h
  [ "$(sha miniaudio/miniaudio.h)" = "$MINIAUDIO_SHA256" ] || { echo "miniaudio.h checksum mismatch" >&2; exit 1; }
fi
if [ ! -f clap/include/clap/clap.h ]; then
  rm -rf clap && git -c advice.detachedHead=false clone -q --depth 1 --branch 1.2.7 https://github.com/free-audio/clap clap
  [ "$(git -C clap rev-parse HEAD)" = "$CLAP_COMMIT" ] || { echo "clap commit mismatch" >&2; exit 1; }
fi
if [ ! -f vst3/pluginterfaces/base/funknown.h ]; then
  rm -rf vst3 && mkdir -p vst3
  git -c advice.detachedHead=false clone -q --depth 1 --branch v3.8.0_build_66 https://github.com/steinbergmedia/vst3_pluginterfaces vst3/pluginterfaces
  [ "$(git -C vst3/pluginterfaces rev-parse HEAD)" = "$VST3_COMMIT" ] || { echo "vst3 commit mismatch" >&2; exit 1; }
  grep -q "MIT License" vst3/pluginterfaces/LICENSE.txt || { echo "VST3 pluginterfaces is not MIT-licensed at this tag" >&2; exit 1; }
fi
echo "third_party ok"
