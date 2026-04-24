#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, cpSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VSCODE_VERSION = '1.115.0';
const REPO_ROOT = resolve(__dirname, '..');
const EXTENSIONS_DIR = resolve(REPO_ROOT, 'extensions');

// Skip if already populated
if (existsSync(EXTENSIONS_DIR) && readdirSync(EXTENSIONS_DIR).length > 10) {
	console.log(`extensions/ already populated (${readdirSync(EXTENSIONS_DIR).length} entries) — skipping.`);
	process.exit(0);
}

mkdirSync(EXTENSIONS_DIR, { recursive: true });

const candidates = [
	// Windows
	`${process.env.LOCALAPPDATA}\\Programs\\Microsoft VS Code\\resources\\app\\extensions`,
	`C:\\Program Files\\Microsoft VS Code\\resources\\app\\extensions`,
	`C:\\Program Files (x86)\\Microsoft VS Code\\resources\\app\\extensions`,
	// Mac
	'/Applications/Visual Studio Code.app/Contents/Resources/app/extensions',
	'/Applications/Cursor.app/Contents/Resources/app/extensions',
	// Linux
	'/usr/share/code/resources/app/extensions',
	'/usr/lib/code/extensions',
	'/opt/visual-studio-code/resources/app/extensions'
];

for (const candidate of candidates) {
	if (existsSync(candidate) && readdirSync(candidate).length > 10) {
		console.log(`Found VS Code extensions at: ${candidate}`);
		console.log('Copying built-in extensions...');
		cpSync(candidate, EXTENSIONS_DIR, { recursive: true });
		console.log(`Copied ${readdirSync(EXTENSIONS_DIR).length} extensions.`);
		process.exit(0);
	}
}

// Fall back to downloading from GitHub using git sparse-checkout
console.log('No local VS Code installation found. Downloading extensions from GitHub...');
const tmpDir = resolve(REPO_ROOT, 'vscode-tmp');

try {
	execSync(`git clone --depth 1 --filter=blob:none --sparse https://github.com/microsoft/vscode.git "${tmpDir}"`, {
		stdio: 'inherit'
	});
	execSync(`git -C "${tmpDir}" sparse-checkout set extensions`, { stdio: 'inherit' });
	cpSync(resolve(tmpDir, 'extensions'), EXTENSIONS_DIR, { recursive: true });
	console.log(`Done — ${readdirSync(EXTENSIONS_DIR).length} extensions installed.`);
} finally {
	if (existsSync(tmpDir)) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}
