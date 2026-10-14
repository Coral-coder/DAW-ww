#!/bin/sh
# Fetches the pinned, permissively licensed third-party sources the native layer builds against
# (kept out of git — they are large and versioned here instead):
#   miniaudio 0.11.22  — public domain / MIT-0 (single header; CoreAudio on macOS, null backend for tests)
#   CLAP 1.2.7         — MIT (header-only plugin ABI)
#   VST3 pluginterfaces v3.8.0 — MIT since VST 3.8 (Steinberg, 2025; see its LICENSE.txt)
#   Ableton Link 3.1.5 — GPL-2.0-or-later (+ asio-standalone, Boost Software License 1.0); only the separate
#                        daw3-link process is built from it. "Or later" makes it usable under GPLv3, which
#                        AGPLv3 §13 / GPLv3 §13 allow to be combined with daW³'s AGPL-3.0-or-later code.
# Audio Units come from the macOS system frameworks (AudioToolbox / CoreAudioKit).
set -eu
cd "$(dirname "$0")"
MINIAUDIO_SHA256=9019743287e443c55e5737a7297f38e5e358561701d6db2d905afb114390c410
CLAP_COMMIT=29ffcc273be7c7c651f6c9953b99e69700e2387a
VST3_COMMIT=31d6eeba6daaa3e2a8bfbe3e7a90ca0b7fbfbc1c
LINK_COMMIT=45931b8bd2a7066f1950f2a0beab81a0c51f28fe
ASIO_COMMIT=231cb29bab30f82712fcd54faaea42424cc6e710

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
if [ ! -f link/include/ableton/Link.hpp ] || [ ! -f link/modules/asio-standalone/asio/include/asio.hpp ]; then
  rm -rf link
  git -c advice.detachedHead=false clone -q --depth 1 --branch Link-3.1.5 https://github.com/Ableton/link link
  [ "$(git -C link rev-parse HEAD)" = "$LINK_COMMIT" ] || { echo "link commit mismatch" >&2; exit 1; }
  git -C link submodule update -q --init --depth 1 modules/asio-standalone
  [ "$(git -C link/modules/asio-standalone rev-parse HEAD)" = "$ASIO_COMMIT" ] || { echo "asio commit mismatch" >&2; exit 1; }
  # the licence check the AGPL compatibility rests on: GPL version 2 "or (at your option) any later version"
  grep -q "either version 2 of the License, or" link/LICENSE.md && grep -q "any later version" link/LICENSE.md || { echo "Ableton Link is no longer GPL-2.0-or-later: re-check the licence before building daw3-link" >&2; exit 1; }
fi
echo "third_party ok"
