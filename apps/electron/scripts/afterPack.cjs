/**
 * electron-builder afterPack hook.
 *
 * v0.0.1 packages a standard native Mkrate .icns generated on macOS by
 * generate-macos-icon.sh from the exact approved 1024px canonical PNG. macOS
 * 26 Liquid Glass Assets.car is deliberately deferred and is not copied here.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CANONICAL_ICON_SHA256 =
  '941584a70cef656815c36e6ab48885579f8c428f6847e81edfbf5e7b970b41b6';

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    console.log('afterPack: not macOS, nothing to do');
    return;
  }

  const productName = context.packager.appInfo.productFilename;
  if (productName !== 'Mkrate') {
    throw new Error(`afterPack: expected Mkrate product name, got ${productName}`);
  }

  const canonicalIcon = path.resolve(
    context.packager.projectDir,
    '..',
    '..',
    'docs',
    'brand',
    'assets',
    'mkrate-icon-1024.png',
  );
  const canonicalHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(canonicalIcon))
    .digest('hex');
  if (canonicalHash !== CANONICAL_ICON_SHA256) {
    throw new Error('afterPack: canonical Mkrate icon hash mismatch; refusing to package.');
  }

  const resourcesDir = path.join(
    context.appOutDir,
    `${productName}.app`,
    'Contents',
    'Resources',
  );
  const bundleIcon = path.join(resourcesDir, 'icon.icns');
  if (!fs.existsSync(bundleIcon) || fs.statSync(bundleIcon).size === 0) {
    throw new Error(`afterPack: native Mkrate icon is missing from ${bundleIcon}`);
  }

  console.log(
    `afterPack: verified native Mkrate .icns in ${productName}.app; ` +
      'Liquid Glass Assets.car remains intentionally deferred.',
  );
};
