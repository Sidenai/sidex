/*---------------------------------------------------------------------------------------------
 *  Unit tests for localServer.ts.
 *
 *  localServer.ts has no VS Code framework dependencies — it only touches
 *  `globalThis`/`window` — so it can be exercised directly with Node's
 *  built-in test runner instead of the workbench's own suite (this repo has
 *  no test runner wired up at all; see package.json). Each test loads a
 *  fresh copy of the module through a cache-busted specifier, since Node's
 *  ESM cache would otherwise share one copy — and with it the module's
 *  cache/inFlight state — across every test in the file.
 *
 *  Run with:
 *    node --experimental-strip-types --test src/vs/workbench/contrib/sidexChat/browser/test/localServer.test.ts
 *--------------------------------------------------------------------------------------------*/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IServerEndpoint } from '../localServer.ts';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type LocalServerModule = typeof import('../localServer.ts');

let moduleInstance = 0;

/** Import a fresh instance of the module under test, isolated from every other test's module-level cache. */
async function loadModule(): Promise<LocalServerModule> {
	moduleInstance++;
	return import(`../localServer.ts?test-instance=${moduleInstance}`) as Promise<LocalServerModule>;
}

/** Install a mock Tauri `invoke` bridge, recording every call made through it. */
function installInvoke(impl: Invoke): { calls: Array<{ cmd: string; args?: Record<string, unknown> }> } {
	const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
	(globalThis as any).__TAURI_INTERNALS__ = {
		invoke: (cmd: string, args?: Record<string, unknown>) => {
			calls.push({ cmd, args });
			return impl(cmd, args);
		}
	};
	return { calls };
}

/** Install a minimal `window` stub so `restartServer()` can dispatch its reconnect event. */
function installWindow(): { events: Event[] } {
	const events: Event[] = [];
	(globalThis as any).window = {
		dispatchEvent: (event: Event): boolean => { events.push(event); return true; }
	};
	return { events };
}

function endpoint(overrides: Partial<IServerEndpoint> = {}): IServerEndpoint {
	return {
		wsUrl: 'ws://127.0.0.1:54321',
		httpUrl: 'http://127.0.0.1:54321',
		port: 54321,
		running: true,
		...overrides
	};
}

afterEach(() => {
	delete (globalThis as any).__TAURI_INTERNALS__;
	delete (globalThis as any).window;
});

// --- URL construction & override handling -----------------------------------------------------

test('serverWsUrl falls back to the built-in default with no override and no Tauri bridge', async () => {
	const mod = await loadModule();
	assert.equal(mod.serverWsUrl(undefined), 'ws://127.0.0.1:7433');
});

test('serverWsUrl honours an explicit override, trimming whitespace and trailing slashes', async () => {
	const mod = await loadModule();
	assert.equal(mod.serverWsUrl('  ws://example.com:9000/// '), 'ws://example.com:9000');
});

test('serverWsUrl treats a blank override as absent', async () => {
	const mod = await loadModule();
	assert.equal(mod.serverWsUrl('   '), 'ws://127.0.0.1:7433');
});

test('serverHttpUrl mirrors serverWsUrl but with an http(s) scheme', async () => {
	const mod = await loadModule();
	assert.equal(mod.serverHttpUrl(undefined), 'http://127.0.0.1:7433');
	assert.equal(mod.serverHttpUrl('wss://example.com:9000'), 'https://example.com:9000');
	assert.equal(mod.serverHttpUrl('ws://example.com:9000'), 'http://example.com:9000');
});

// --- getServerEndpoint / isServerEndpointResolved ---------------------------------------------

test('getServerEndpoint returns the fallback before anything has resolved', async () => {
	const mod = await loadModule();
	assert.deepEqual(mod.getServerEndpoint(), {
		wsUrl: 'ws://127.0.0.1:7433',
		httpUrl: 'http://127.0.0.1:7433',
		port: 7433,
		running: false
	});
});

test('isServerEndpointResolved is true outside Tauri: the fallback is the final answer, not a pending one', async () => {
	const mod = await loadModule();
	assert.equal(mod.isServerEndpointResolved(), true);
});

test('isServerEndpointResolved is false until the Tauri bridge actually answers', async () => {
	const mod = await loadModule();
	installInvoke(() => new Promise(() => { /* never settles */ }));
	void mod.resolveServerEndpoint();
	assert.equal(mod.isServerEndpointResolved(), false, 'a request in flight is not a resolution yet');
});

// --- resolveServerEndpoint: cache / retry behaviour -------------------------------------------

test('a confirmed running endpoint is cached and not re-requested', async () => {
	const mod = await loadModule();
	const ep = endpoint({ running: true });
	const { calls } = installInvoke(async () => ep);

	const first = await mod.resolveServerEndpoint();
	assert.deepEqual(first, ep);
	assert.equal(calls.length, 1);
	assert.equal(mod.isServerEndpointResolved(), true);
	assert.deepEqual(mod.getServerEndpoint(), ep);

	// Once settled, a second caller must not pay for another IPC round trip.
	const second = await mod.resolveServerEndpoint();
	assert.deepEqual(second, ep);
	assert.equal(calls.length, 1, 'a settled resolution must be served from cache');
});

test('a "not running" answer is real information but stays retryable', async () => {
	const mod = await loadModule();
	let callCount = 0;
	installInvoke(async () => {
		callCount++;
		// First answer: the port is reserved but the process never came up.
		// Second answer: it has since started (e.g. the user fixed the binary
		// and restarted).
		return callCount === 1 ? endpoint({ running: false }) : endpoint({ running: true });
	});

	const first = await mod.resolveServerEndpoint();
	assert.equal(first.running, false);
	// This is a real, confirmed answer — the UI can already tell the server
	// isn't up, even though the resolver isn't done trying.
	assert.equal(mod.isServerEndpointResolved(), true);

	const second = await mod.resolveServerEndpoint();
	assert.equal(callCount, 2, 'an unsettled ("not running") answer must be retried, not cached forever');
	assert.equal(second.running, true);
});

test('a port-0 reply is treated as unresolved and does not clobber the cache', async () => {
	const mod = await loadModule();
	let callCount = 0;
	installInvoke(async () => {
		callCount++;
		return callCount === 1
			? { wsUrl: 'ws://127.0.0.1:0', httpUrl: 'http://127.0.0.1:0', port: 0, running: false }
			: endpoint({ running: true });
	});

	const first = await mod.resolveServerEndpoint();
	assert.equal(first.port, 7433, 'a port-0 reply must not overwrite the cache with an unusable URL');

	const second = await mod.resolveServerEndpoint();
	assert.equal(callCount, 2, 'must retry rather than getting stuck on the port-0 reply');
	assert.equal(second.port, 54321);
});

test('a rejected IPC call is retried on the next call, leaving the cache untouched', async () => {
	const mod = await loadModule();
	let callCount = 0;
	installInvoke(async () => {
		callCount++;
		if (callCount === 1) { throw new Error('IPC channel not ready'); }
		return endpoint({ running: true });
	});

	const first = await mod.resolveServerEndpoint();
	assert.equal(first.port, 7433);
	assert.equal(mod.isServerEndpointResolved(), false, 'a failed call is not an answer');

	const second = await mod.resolveServerEndpoint();
	assert.equal(callCount, 2);
	assert.equal(second.port, 54321);
});

test('a malformed reply is retried rather than trusted', async () => {
	const mod = await loadModule();
	let callCount = 0;
	installInvoke(async () => {
		callCount++;
		return callCount === 1 ? { unexpected: true } : endpoint({ running: true });
	});

	await mod.resolveServerEndpoint();
	assert.equal(mod.isServerEndpointResolved(), false);

	await mod.resolveServerEndpoint();
	assert.equal(callCount, 2);
});

test('concurrent callers share a single in-flight request', async () => {
	const mod = await loadModule();
	let resolveInvoke: (value: IServerEndpoint) => void = () => { /* replaced below */ };
	const { calls } = installInvoke(() => new Promise<IServerEndpoint>(resolve => { resolveInvoke = resolve; }));

	const a = mod.resolveServerEndpoint();
	const b = mod.resolveServerEndpoint();
	assert.equal(calls.length, 1, 'both callers should share the one in-flight request');

	resolveInvoke(endpoint({ running: true }));
	const [ra, rb] = await Promise.all([a, b]);
	assert.deepEqual(ra, rb);
});

// --- restartServer -----------------------------------------------------------------------------

test('restartServer updates the cache and fires the reconnect event on success', async () => {
	const mod = await loadModule();
	const { events } = installWindow();
	const ep = endpoint({ running: true, port: 9999, wsUrl: 'ws://127.0.0.1:9999', httpUrl: 'http://127.0.0.1:9999' });
	installInvoke(async () => ep);

	const result = await mod.restartServer();
	assert.deepEqual(result, ep);
	assert.deepEqual(mod.getServerEndpoint(), ep);
	assert.equal(events.length, 1);
	assert.equal(events[0].type, mod.SERVER_RESTARTED_EVENT);
});

test('restartServer still signals reconnect when the respawn itself failed, since the old process is dead either way', async () => {
	const mod = await loadModule();
	const { events } = installWindow();
	const ep = endpoint({ running: false });
	installInvoke(async () => ep);

	const result = await mod.restartServer();
	assert.equal(result.running, false);
	assert.equal(events.length, 1);
});

test('restartServer leaves the cache untouched and skips the reconnect signal when the IPC call itself fails', async () => {
	const mod = await loadModule();
	const { events } = installWindow();
	installInvoke(async () => { throw new Error('command not found'); });

	const before = mod.getServerEndpoint();
	const result = await mod.restartServer();
	assert.deepEqual(result, before);
	assert.equal(events.length, 0, 'an unknown outcome should not tell holders to reconnect to a guess');
});

test('restartServer is a no-op outside Tauri', async () => {
	const mod = await loadModule();
	const { events } = installWindow();

	const result = await mod.restartServer();
	assert.deepEqual(result, mod.getServerEndpoint());
	assert.equal(events.length, 0);
});
