#!/usr/bin/env node
/*
 * Libre WebUI - Icon Generator
 * Generates app icons for macOS, Windows, and Linux from SVG source
 *
 * Usage: npm run generate-icons
 * Requires: sharp (npm install sharp)
 */

const fs = require('fs');
const path = require('path');

async function generateIcons() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.error('sharp not installed. Run: npm install sharp --save-dev');
    console.log('Skipping icon generation...');
    return;
  }

  const assetsDir = path.join(__dirname, '..', 'electron', 'assets');
  const iconsDir = path.join(assetsDir, 'icons');

  // Use PNG source (logo-dark.png) if available, otherwise fall back to SVG
  const pngPath = path.join(assetsDir, 'icon-source.png');
  const svgPath = path.join(assetsDir, 'icon.svg');
  const sourcePath = fs.existsSync(pngPath) ? pngPath : svgPath;

  // Ensure directories exist
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }

  console.log(`Using source: ${path.basename(sourcePath)}`);
  const sourceBuffer = fs.readFileSync(sourcePath);

  // Generate PNG icons for various sizes
  const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];

  console.log('Generating PNG icons...');
  for (const size of sizes) {
    await sharp(sourceBuffer)
      .resize(size, size)
      .png()
      .toFile(path.join(iconsDir, `${size}x${size}.png`));
    console.log(`  ✓ ${size}x${size}.png`);
  }

  // Generate icon.png (512x512 for general use)
  await sharp(sourceBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(assetsDir, 'icon.png'));
  console.log('  ✓ icon.png (512x512)');

  // For macOS .icns, we need to use iconutil or a library
  // For now, we'll generate the required PNGs and note that icns needs manual creation
  console.log('\n📝 Note: For macOS .icns file:');
  console.log('   Run: iconutil -c icns electron/assets/icon.iconset');
  console.log('   After creating icon.iconset folder with properly named files\n');

  // Create iconset structure for macOS
  const iconsetDir = path.join(assetsDir, 'icon.iconset');
  if (!fs.existsSync(iconsetDir)) {
    fs.mkdirSync(iconsetDir, { recursive: true });
  }

  const iconsetSizes = [
    { size: 16, scale: 1, name: 'icon_16x16.png' },
    { size: 16, scale: 2, name: 'icon_16x16@2x.png' },
    { size: 32, scale: 1, name: 'icon_32x32.png' },
    { size: 32, scale: 2, name: 'icon_32x32@2x.png' },
    { size: 128, scale: 1, name: 'icon_128x128.png' },
    { size: 128, scale: 2, name: 'icon_128x128@2x.png' },
    { size: 256, scale: 1, name: 'icon_256x256.png' },
    { size: 256, scale: 2, name: 'icon_256x256@2x.png' },
    { size: 512, scale: 1, name: 'icon_512x512.png' },
    { size: 512, scale: 2, name: 'icon_512x512@2x.png' },
  ];

  console.log('Generating macOS iconset...');
  for (const { size, scale, name } of iconsetSizes) {
    const actualSize = size * scale;
    await sharp(sourceBuffer)
      .resize(actualSize, actualSize)
      .png()
      .toFile(path.join(iconsetDir, name));
  }

  // Try to generate .icns file on macOS
  if (process.platform === 'darwin') {
    const { execSync } = require('child_process');
    try {
      execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(assetsDir, 'icon.icns')}"`, {
        stdio: 'inherit',
      });
      console.log('  ✓ icon.icns generated');
    } catch (error) {
      console.log('  ⚠ Could not generate .icns (iconutil failed)');
    }
  }

  // Generate Windows .ico (requires multiple sizes embedded)
  // For now, just copy the 256x256 as a placeholder
  console.log('\n📝 Note: For Windows .ico file:');
  console.log('   Use an online converter or tool like png2ico\n');

  console.log('✅ Icon generation complete!');
}

generateIcons().catch(console.error);
