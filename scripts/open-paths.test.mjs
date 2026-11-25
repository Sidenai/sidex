import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenPathsHandler } from '../src/open-paths.ts';

function fixture(batches = []) {
	const opened = [];
	const errors = [];
	let saved = null;
	const host = {
		take: async () => batches.shift() ?? null,
		load: () => saved,
		save: paths => {
			saved = paths;
		},
		clear: () => {
			saved = null;
		},
		openWorkspace: () => false,
		openFile: async path => {
			opened.push(path);
		},
		onError: error => errors.push(error)
	};
	return { host, opened, errors };
}

test('cold-start files and concurrent wake-ups are consumed exactly once', async () => {
	const { host, opened } = fixture([
		[{ kind: 'file', path: 'C:\\hello 世界.js' }],
		[{ kind: 'file', path: 'C:\\with spaces\\test.json' }]
	]);
	const drain = createOpenPathsHandler(host);
	await Promise.all([drain(), drain(), drain()]);
	assert.deepEqual(opened, ['C:\\hello 世界.js', 'C:\\with spaces\\test.json']);
	assert.equal(host.load(), null);
});

test('mixed folder and file launch survives reload; later launches stay queued', async () => {
	const { host, opened } = fixture([
		[
			{ kind: 'file', path: 'a.js' },
			{ kind: 'folder', path: 'project' }
		],
		[{ kind: 'file', path: 'b.json' }]
	]);
	host.openWorkspace = () => true;
	const oldPage = createOpenPathsHandler(host);
	await oldPage();
	await oldPage();
	assert.deepEqual(opened, []);
	assert.equal(host.load().length, 2);
	host.openWorkspace = () => false;
	await createOpenPathsHandler(host)();
	assert.deepEqual(opened, ['a.js', 'b.json']);
	assert.equal(host.load(), null);
});

test('the last workspace argument wins and workspace files are not editor files', async () => {
	const { host, opened } = fixture([
		[
			{ kind: 'folder', path: 'first' },
			{ kind: 'workspace', path: 'project.code-workspace' }
		]
	]);
	const workspaces = [];
	host.openWorkspace = path => {
		workspaces.push(path);
		return false;
	};
	await createOpenPathsHandler(host)();
	assert.deepEqual(workspaces, [{ kind: 'workspace', path: 'project.code-workspace' }]);
	assert.deepEqual(opened, []);
});

test('an unreadable file does not prevent subsequent files from opening', async () => {
	const { host, opened, errors } = fixture([
		[
			{ kind: 'file', path: 'bad.js' },
			{ kind: 'file', path: 'good.js' }
		]
	]);
	host.openFile = async path => {
		if (path === 'bad.js') {
			throw new Error('unreadable');
		}
		opened.push(path);
	};
	await createOpenPathsHandler(host)();
	assert.deepEqual(opened, ['good.js']);
	assert.equal(errors.length, 1);
});

test('a request arriving during file opening is drained without another event', async () => {
	const batches = [[{ kind: 'file', path: 'first.js' }]];
	const { host, opened } = fixture(batches);
	host.openFile = async path => {
		opened.push(path);
		if (path === 'first.js') {
			batches.push([{ kind: 'file', path: 'second.js' }]);
		}
	};
	await createOpenPathsHandler(host)();
	assert.deepEqual(opened, ['first.js', 'second.js']);
});
