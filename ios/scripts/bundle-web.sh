#!/bin/sh
# Copy the daW³ web app into the app bundle (…/daW3.app/web). Run by Xcode as a build phase
# (see project.yml) and usable by hand: bundle-web.sh <repo root> <destination folder>.
set -eu
REPO="${1:-${SRCROOT}/..}"
DEST="${2:-${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/web}"
rm -rf "$DEST"
mkdir -p "$DEST"
for item in index.html manifest.webmanifest src styles vendor icons; do
  if [ -e "$REPO/$item" ]; then
    cp -R "$REPO/$item" "$DEST/"
  else
    echo "warning: $item missing from $REPO" >&2
  fi
done
# Never ship the service worker (custom-scheme pages can't register one; the bundle is already offline).
rm -f "$DEST/sw.js"
echo "bundled web app -> $DEST ($(du -sh "$DEST" | cut -f1))"
