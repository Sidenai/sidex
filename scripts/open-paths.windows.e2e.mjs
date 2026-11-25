import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

// Run on Windows from an interactive desktop with no other SideX instance open.
const executable = resolve(process.argv[2] ?? 'target/debug/SideX.exe');
const fixture = await mkdtemp(join(resolve(process.argv[3] ?? '.'), 'sidex-launch-'));
const project = join(fixture, 'Sample Project');
const js = 'hello 世界.js';
const json = 'second file.json';
const extra = 'third file.js';
const config = 'sample.code-workspace';
await mkdir(project);
await writeFile(join(project, js), 'const launchMarker = "cold";\n');
await writeFile(join(project, json), '{"launchMarker":"warm"}\n');
await writeFile(join(project, extra), 'const launchMarker = "third";\n');
await writeFile(join(fixture, config), JSON.stringify({ folders: [{ path: basename(project) }] }));

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const { port } = probe.address();
await new Promise((done, fail) => probe.close(error => (error ? fail(error) : done())));
const endpoint = 'http://127.0.0.1:' + port;
const env = {
	...process.env,
	WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
	WEBVIEW2_USER_DATA_FOLDER: join(fixture, 'webview')
};
const processes = new Set();
let browser;

function launch(args = [], cwd = fixture) {
	const child = spawn(executable, args, { cwd, env, stdio: 'ignore', windowsHide: true });
	processes.add(child);
	child.once('exit', () => processes.delete(child));
	child.once('error', error => console.error('Could not launch SideX:', error));
	return child;
}

async function connect(child) {
	for (let attempt = 0; attempt < 150; attempt++) {
		assert.equal(child.exitCode, null, 'SideX exited before its WebView started');
		const response = await fetch(endpoint + '/json/list').catch(() => null);
		const targets = response?.ok ? await response.json() : [];
		if (targets.some(target => target.type === 'page')) {
			browser = await chromium.connectOverCDP(endpoint);
			return browser.contexts()[0].pages()[0];
		}
		await delay(200);
	}
	throw new Error('Timed out waiting for the native SideX WebView');
}

async function expectEditor(page, filename, marker) {
	const editor = page.locator('.editor-instance .view-lines').filter({ hasText: marker }).first();
	await editor.waitFor({ state: 'visible', timeout: 45000 });
	await page.waitForFunction(name => {
		const active = window.__sidex_editorService?.activeEditor;
		return active?.resource?.path.endsWith('/' + name);
	}, filename);
}

async function expectWorkspace(page, parameter, filename) {
	await page.waitForURL(url => new URLSearchParams(url.search).get(parameter)?.endsWith(filename), { timeout: 45000 });
	await page.waitForFunction(() => Boolean(window.__sidex_commandService));
	await page.evaluate(() => window.__sidex_commandService.executeCommand('workbench.view.explorer'));
	await page
		.locator('.explorer-folders-view')
		.getByText(js, { exact: true })
		.waitFor({ state: 'visible', timeout: 45000 });
}

async function forward(primary, args, cwd) {
	const secondary = launch(args, cwd);
	const exit = once(secondary, 'exit');
	const [code] = await Promise.race([exit, delay(15000, [null], { ref: false })]);
	assert.equal(code, 0, 'The forwarded instance should exit successfully');
	assert.equal(primary.exitCode, null, 'The original instance should stay running');
}

async function stop(child) {
	if (child.exitCode === null && child.signalCode === null) {
		const exited = once(child, 'exit');
		child.kill();
		await exited;
	}
	await browser?.close();
	browser = undefined;
}

try {
	let primary = launch([join(project, js)], dirname(fixture));
	let page = await connect(primary);
	page.on('console', message => {
		if (message.type() === 'error') console.error('[webview]', message.text());
	});
	await expectEditor(page, js, 'launchMarker');
	console.log('PASS cold start opens an absolute JavaScript path with spaces and Unicode');

	await forward(primary, [json], project);
	await expectEditor(page, json, 'warm');
	console.log('PASS running instance opens a relative JSON path from the second launch directory');

	await forward(primary, [basename(project), join(basename(project), js)], fixture);
	await expectWorkspace(page, 'folder', encodeURIComponent(basename(project)));
	await expectEditor(page, js, 'launchMarker');
	console.log('PASS running instance opens a folder and preserves its companion file across reload');

	await forward(primary, [config], fixture);
	await expectWorkspace(page, 'workspace', config);
	console.log('PASS running instance opens a .code-workspace and populates its explorer');
	await forward(primary, [join(project, json), join(project, extra)], fixture);
	await expectEditor(page, extra, 'third');
	await page.locator('.tabs-container .tab').getByText(json, { exact: true }).waitFor({ state: 'visible' });
	console.log('PASS two files from one launch are both opened, with the last file active');
	await stop(primary);

	primary = launch([basename(project), join(basename(project), json)]);
	page = await connect(primary);
	await expectEditor(page, json, 'warm');
	await expectWorkspace(page, 'folder', encodeURIComponent(basename(project)));
	console.log('PASS cold start opens a relative folder and file');
	await stop(primary);

	primary = launch(['--unsupported', 'missing.js']);
	page = await connect(primary);
	await page.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 45000 });
	assert.equal(new URL(page.url()).search, '');
	console.log('PASS missing paths and unsupported flags leave the workbench open');
	await stop(primary);
} finally {
	for (const child of [...processes]) await stop(child);
	await browser?.close();
	await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(error => {
		console.warn('Could not remove the temporary test profile:', error.message);
	});
}
