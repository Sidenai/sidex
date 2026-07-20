#!/usr/bin/env node
/**
 * Downloads a pinned Node.js binary for the current build platform and places
 * it at src-tauri/bin/node (or node.exe on Windows).  Tauri then picks it up
 * via the `resources` entry in tauri.conf.json.
 *
 * Run automatically as beforeBuildCommand in tauri.conf.json.
 * Set SIDEX_SKIP_BUNDLE_NODE=1 to skip (e.g. when you want to supply your own).
 *
 * Only uses Node.js built-in modules — no npm dependencies required.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(REPO_ROOT, 'src-tauri', 'bin');

const NODE_VERSION = '22.17.0';

// Map [process.platform, process.arch] -> Node dist filename components
const PLATFORM_MAP = {
  'darwin-arm64': { suffix: 'darwin-arm64', ext: '.tar.gz', bin: 'node' },
  'darwin-x64':   { suffix: 'darwin-x64',   ext: '.tar.gz', bin: 'node' },
  'linux-arm64':  { suffix: 'linux-arm64',   ext: '.tar.gz', bin: 'node' },
  'linux-x64':    { suffix: 'linux-x64',     ext: '.tar.gz', bin: 'node' },
  'win32-x64':    { suffix: 'win-x64',       ext: '.zip',    bin: 'node.exe' },
  'win32-arm64':  { suffix: 'win-arm64',     ext: '.zip',    bin: 'node.exe' },
};

function getNodeUrl(suffix, ext) {
  return `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${suffix}${ext}`;
}

/** Follow redirects and resolve to a response stream. */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          follow(res.headers.location);
        } else if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        } else {
          resolve(res);
        }
      }).on('error', reject);
    };
    follow(url);
  });
}

/** Download url to a local file, returns path. */
async function download(url, destFile) {
  const res = await httpsGet(url);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destFile);
    res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.on('error', reject);
  });
}

/** Extract node binary from a .tar.gz archive using the system `tar` command. */
function extractTarGz(archivePath, internalBin, destBin) {
  const tmpDir = fs.mkdtempSync(path.join(BIN_DIR, '.tmp-node-'));
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', tmpDir]);
    const entries = fs.readdirSync(tmpDir);
    const topDir = entries.find((e) => e.startsWith('node-'));
    if (!topDir) throw new Error('Unexpected tar layout: ' + entries.join(', '));
    const src = path.join(tmpDir, topDir, 'bin', internalBin);
    if (!fs.existsSync(src)) throw new Error('Binary not found inside archive: ' + src);
    fs.copyFileSync(src, destBin);
    fs.chmodSync(destBin, 0o755);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Extract node binary from a .zip archive. */
function extractZip(archivePath, internalBin, destBin) {
  const tmpDir = fs.mkdtempSync(path.join(BIN_DIR, '.tmp-node-'));
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', [
        '-NoProfile', '-Command',
        `Expand-Archive -Force -Path "${archivePath}" -DestinationPath "${tmpDir}"`,
      ]);
    } else {
      execFileSync('unzip', ['-q', archivePath, '-d', tmpDir]);
    }
    const entries = fs.readdirSync(tmpDir);
    const topDir = entries.find((e) => e.startsWith('node-'));
    if (!topDir) throw new Error('Unexpected zip layout: ' + entries.join(', '));
    const src = path.join(tmpDir, topDir, internalBin);
    if (!fs.existsSync(src)) throw new Error('Binary not found inside archive: ' + src);
    fs.copyFileSync(src, destBin);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env.SIDEX_SKIP_BUNDLE_NODE === '1') {
    console.log('[bundle-node] SIDEX_SKIP_BUNDLE_NODE=1, skipping.');
    return;
  }

  const key = `${process.platform}-${process.arch}`;
  const platform = PLATFORM_MAP[key];
  if (!platform) {
    console.warn(`[bundle-node] Unsupported platform ${key}, skipping.`);
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const destBin = path.join(BIN_DIR, platform.bin);

  if (fs.existsSync(destBin)) {
    console.log(`[bundle-node] ${destBin} already exists, skipping download.`);
    return;
  }

  const url = getNodeUrl(platform.suffix, platform.ext);
  const tmpArchive = path.join(BIN_DIR, `.tmp-node-download${platform.ext}`);
  console.log(`[bundle-node] Downloading Node.js v${NODE_VERSION} (${key})...`);

  try {
    await download(url, tmpArchive);
    console.log(`[bundle-node] Extracting...`);
    if (platform.ext === '.tar.gz') {
      extractTarGz(tmpArchive, platform.bin, destBin);
    } else {
      extractZip(tmpArchive, platform.bin, destBin);
    }
  } finally {
    fs.rmSync(tmpArchive, { force: true });
  }

  console.log(`[bundle-node] Node.js binary ready: ${destBin}`);
}

main().catch((err) => {
  console.error('[bundle-node] FAILED:', err.message);
  process.exit(1);
});
