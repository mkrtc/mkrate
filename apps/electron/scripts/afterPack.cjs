/**
 * electron-builder afterPack hook
 *
 * macOS icon status: DEFERRED / BLOCKED for this rebrand phase.
 *
 * The old Craft macOS icon artifacts — `resources/icon.icns`,
 * `resources/Assets.car` (macOS 26+ Liquid Glass), and the `resources/icon.icon`
 * asset catalog — were REMOVED during the Mkrate rebrand and have NOT been
 * regenerated, because a native `.icns` / `Assets.car` requires Apple tooling
 * (`iconutil` / `actool`) running on macOS, which is out of scope for this pass.
 *
 * This hook therefore ships NO Liquid Glass icon: on macOS the build falls back
 * to the icon derived by electron-builder from `resources/icon.png` (the approved
 * Mkrate app icon). That derived icon is a placeholder for local/dev builds only.
 *
 * macOS PRODUCTION PACKAGING IS BLOCKED: do not release a macOS binary until a
 * native Mkrate `.icns` and `Assets.car` are generated from the approved SVG in
 * `docs/brand/assets/` and validated on macOS. To regenerate later (on macOS):
 *   cd apps/electron
 *   # (recreate resources/icon.icon/ from docs/brand/assets/mkrate-icon-square.svg first)
 *   xcrun actool "resources/icon.icon" --compile "resources" \
 *     --app-icon AppIcon --minimum-deployment-target 26.0 \
 *     --platform macosx --output-partial-info-plist /dev/null
 * then restore the `icon`/`CFBundleIconName` references in electron-builder.yml.
 */

const path = require('path');
const fs = require('fs');

module.exports = async function afterPack(context) {
  // Only process macOS builds
  if (context.electronPlatformName !== 'darwin') {
    console.log('afterPack: not macOS, nothing to do');
    return;
  }

  // The Mkrate .app bundle Resources dir (kept in sync with productName: Mkrate).
  const resourcesDir = path.join(context.appOutDir, 'Mkrate.app', 'Contents', 'Resources');
  const precompiledAssets = path.join(context.packager.projectDir, 'resources', 'Assets.car');

  console.warn(
    '\n============================================================\n' +
    'afterPack: macOS Liquid Glass icon is DEFERRED for Mkrate.\n' +
    'No Assets.car / .icns is bundled — the app uses the placeholder\n' +
    'icon derived from resources/icon.png. DO NOT RELEASE this macOS\n' +
    'build: generate a native .icns/Assets.car on macOS first.\n' +
    `(Resources dir: ${resourcesDir})\n` +
    '============================================================\n'
  );

  // Defensive: if a native Assets.car is later reintroduced in resources/, copy it.
  if (fs.existsSync(precompiledAssets)) {
    try {
      fs.copyFileSync(precompiledAssets, path.join(resourcesDir, 'Assets.car'));
      console.log('afterPack: found a native Assets.car — copied into the bundle.');
    } catch (err) {
      console.log(`afterPack: could not copy Assets.car: ${err.message}`);
    }
  }
};
