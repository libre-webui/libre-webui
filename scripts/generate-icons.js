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
const { execFileSync, execSync } = require('child_process');

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
  console.log(
    '   After creating icon.iconset folder with properly named files\n'
  );

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
    try {
      execSync(
        `iconutil -c icns "${iconsetDir}" -o "${path.join(assetsDir, 'icon.icns')}"`,
        {
          stdio: 'inherit',
        }
      );
      console.log('  ✓ icon.icns generated');
    } catch (error) {
      console.log('  ⚠ Could not generate .icns (iconutil failed)');
    }
  }

  // Generate DMG background from SVG
  const dmgBgSvgPath = path.join(assetsDir, 'dmg-background.svg');
  const dmgBgPngPath = path.join(assetsDir, 'dmg-background.png');
  const dmgBgRetinaPngPath = path.join(assetsDir, 'dmg-background@2x.png');
  const dmgBgTiffPath = path.join(assetsDir, 'dmg-background.tiff');
  const dmgArtPath = path.join(assetsDir, 'dmg-art.png');
  if (fs.existsSync(dmgBgSvgPath)) {
    console.log('\nGenerating DMG background...');
    const dmgWidth = 760;
    const dmgHeight = 500;
    const dmgArtHeight = 176;
    const dmgDensity = 72;
    const backgroundSvg = fs.readFileSync(dmgBgSvgPath);

    for (const scale of [1, 2]) {
      const width = dmgWidth * scale;
      const height = dmgHeight * scale;
      const density = dmgDensity * scale;
      const composites = [];

      if (fs.existsSync(dmgArtPath)) {
        const artBuffer = await sharp(dmgArtPath)
          .resize(width, dmgArtHeight * scale, {
            fit: 'cover',
            position: 'centre',
          })
          .png()
          .toBuffer();
        composites.push({ input: artBuffer, top: 0, left: 0 });
      }

      const overlayBuffer = await sharp(backgroundSvg, { density })
        .resize(width, height)
        .png()
        .toBuffer();
      composites.push({ input: overlayBuffer, top: 0, left: 0 });

      const outputPath = scale === 1 ? dmgBgPngPath : dmgBgRetinaPngPath;
      await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: '#f3f0ea',
        },
      })
        .composite(composites)
        .png()
        .withMetadata({ density })
        .toFile(outputPath);
      console.log(
        `  ✓ ${path.basename(outputPath)} generated at ${density} DPI`
      );
    }

    if (process.platform === 'darwin') {
      execFileSync(
        '/usr/bin/tiffutil',
        [
          '-cathidpicheck',
          dmgBgPngPath,
          dmgBgRetinaPngPath,
          '-out',
          dmgBgTiffPath,
        ],
        { stdio: 'inherit' }
      );
      console.log('  ✓ dmg-background.tiff generated with Retina resources');
    }
  }

  // Generate Windows .ico file
  console.log('\nGenerating Windows .ico...');
  try {
    const pngToIcoModule = require('png-to-ico');
    const pngToIco = pngToIcoModule.default || pngToIcoModule;
    const icoSizes = [16, 32, 48, 256];
    const icoPngs = icoSizes.map(size =>
      path.join(iconsDir, `${size}x${size}.png`)
    );
    const icoBuffer = await pngToIco(icoPngs);
    fs.writeFileSync(path.join(assetsDir, 'icon.ico'), icoBuffer);
    console.log('  ✓ icon.ico generated');
  } catch (error) {
    console.log('  ⚠ Could not generate .ico:', error.message);
    console.log('    Run: npm install png-to-ico --save-dev');
  }

  console.log('\n✅ Icon generation complete!');
}

generateIcons().catch(console.error);
