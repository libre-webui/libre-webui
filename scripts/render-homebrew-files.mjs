#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);

function getArg(name) {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) {
    return undefined;
  }
  return args[index + 1];
}

function ensureHexSha(value, label) {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a 64-character SHA256 hex string`);
  }
  return value.toLowerCase();
}

function normalizeVersion(version) {
  return version.startsWith('v') ? version.slice(1) : version;
}

function renderTemplate(templatePath, replacements) {
  const template = fs.readFileSync(templatePath, 'utf8');
  return Object.entries(replacements).reduce(
    (content, [token, value]) => content.replaceAll(`{{${token}}}`, value),
    template
  );
}

function writeFile(outputPath, content) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content);
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
);
const version = normalizeVersion(getArg('--version') ?? packageJson.version);
const npmSha = ensureHexSha(
  getArg('--npm-sha') ?? getArg('--source-sha'),
  'npm sha'
);
const dmgSha = getArg('--dmg-sha');
const outputDir = path.resolve(
  repoRoot,
  getArg('--output-dir') ?? 'homebrew/generated'
);

const formulaTemplatePath = path.join(
  repoRoot,
  'homebrew',
  'libre-webui-formula.template'
);
const caskTemplatePath = path.join(
  repoRoot,
  'homebrew',
  'libre-webui-cask.template'
);

const formulaOutputPath = path.join(outputDir, 'Formula', 'libre-webui.rb');
const caskOutputPath = path.join(outputDir, 'Casks', 'libre-webui.rb');

const formulaContent = renderTemplate(formulaTemplatePath, {
  VERSION: version,
  NPM_SHA256: npmSha,
});

writeFile(formulaOutputPath, formulaContent);

if (dmgSha) {
  const caskContent = renderTemplate(caskTemplatePath, {
    VERSION: version,
    DMG_SHA256: ensureHexSha(dmgSha, 'dmg sha'),
  });

  writeFile(caskOutputPath, caskContent);
}

console.log(`Rendered Homebrew files for v${version} to ${outputDir}`);
