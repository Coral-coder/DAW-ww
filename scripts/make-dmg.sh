#!/bin/sh
# Pack each built daW3.app (dist/mac*/daW3.app) into a .dmg with an Applications shortcut.
# `hdiutil create -srcfolder` never attaches the image, so it avoids the "hdiutil detach: resource busy"
# failures electron-builder's dmg target hits on GitHub's macOS runners.
set -e
VERSION=$(node -p "require('./package.json').version")
for app in dist/mac*/daW3.app; do
  [ -d "$app" ] || continue
  case "$app" in *arm64*) ARCH=arm64 ;; *) ARCH=x64 ;; esac
  STAGE=$(mktemp -d)
  cp -R "$app" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  OUT="dist/daW3-$VERSION-$ARCH.dmg"
  rm -f "$OUT"
  for i in 1 2 3; do
    hdiutil create -volname "daW3 $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$OUT" && break
    echo "hdiutil create failed (attempt $i), retrying…"; sleep 5
  done
  rm -rf "$STAGE"
  [ -f "$OUT" ] && echo "built $OUT"
done
ls dist/*.dmg
