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
  # the app unsealed and macOS reports a downloaded copy as "damaged"). Every Mach-O file first, found by its
  # magic (`file`), not by name or exec bit: the x64 "Electron Framework" binary has no extension, no +x and is
  # not linker-signed (the arm64 one is), so a name / +x filter missed it ("code object is not signed at all").
  # Then the helper apps and frameworks, then a final --deep pass over the app, then a strict verify.
  # Deepest first, and never the main executable here: codesign treats Contents/MacOS/daW3 as the whole bundle and
  # refuses while anything nested is still unsigned — it is sealed by the final pass over the app.
  find "$app/Contents" -type f ! -path "$app/Contents/MacOS/*" ! -name '*.asar' ! -name '*.pak' ! -name '*.png' ! -name '*.js' \
    | awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2- \
    | while IFS= read -r f; do
        if file -b "$f" | grep -q 'Mach-O'; then codesign --force --sign - --timestamp=none "$f"; fi
      done
  for h in "$app"/Contents/Frameworks/*.app; do [ -e "$h" ] && codesign --force --sign - --timestamp=none "$h"; done
  for fw in "$app"/Contents/Frameworks/*.framework; do [ -e "$fw" ] && codesign --force --sign - --timestamp=none "$fw"; done
  codesign --force --deep --sign - --timestamp=none "$app"
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
