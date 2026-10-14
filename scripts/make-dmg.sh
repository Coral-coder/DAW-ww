#!/bin/bash
# Pack each built daW3.app (dist/mac*/daW3.app) into a .dmg with an Applications shortcut.
# `hdiutil create -srcfolder` never attaches the image, so it avoids the "hdiutil detach: resource busy"
# failures electron-builder's dmg target hits on GitHub's macOS runners.
set -e
VERSION=$(node -p "require('./package.json').version")
for app in dist/mac*/daW3.app; do
  [ -d "$app" ] || continue
  case "$app" in *arm64*) ARCH=arm64 ;; *) ARCH=x64 ;; esac
  # Ad-hoc sign the whole bundle (electron-builder skips signing when no identity is installed, which leaves
  # the app unsealed and macOS reports a downloaded copy as "damaged"). Inner Mach-O files first (native
  # addon, plugin host, Link helper, Electron helpers/frameworks), then the app itself; verify strictly.
  find "$app/Contents" -type f \( -name '*.node' -o -name '*.dylib' -o -perm -u+x \) -print0 \
    | while IFS= read -r -d '' f; do
        if file "$f" | grep -q 'Mach-O'; then codesign --force --sign - --timestamp=none "$f"; fi
      done
  for fw in "$app"/Contents/Frameworks/*.framework "$app"/Contents/Frameworks/*.app; do
    [ -e "$fw" ] && codesign --force --sign - --timestamp=none "$fw"
  done
  codesign --force --sign - --timestamp=none "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
  # the .zip electron-builder made earlier holds the unsigned app: rebuild it from the signed one
  ZIP=$(ls dist/*"$ARCH"*-mac.zip 2>/dev/null | head -1); [ "$ARCH" = x64 ] && ZIP=$(ls dist/*-mac.zip 2>/dev/null | grep -v arm64 | head -1)
  if [ -n "$ZIP" ]; then rm -f "$ZIP" "$ZIP.blockmap"; ditto -c -k --sequesterRsrc --keepParent "$app" "$ZIP"; echo "re-zipped $ZIP"; fi
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
