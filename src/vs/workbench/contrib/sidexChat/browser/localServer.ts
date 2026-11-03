/*---------------------------------------------------------------------------------------------
 *  Local agent server endpoint.
 *
 *  SideX runs its own `sidex-server` on loopback (see `src-tauri/src/server.rs`).
 *  The port is chosen at launch, so it has to be asked for rather than assumed.
 *  This module resolves it once and hands the result to every caller that needs
 *  to open a socket — chat, autocomplete and inline edit.
 *--------------------------------------------------------------------------------------------*/

export interface IServerEndpoint {
	wsUrl: string;
	httpUrl: string;
	port: number;
	running: boolean;
	/** Why the supervisor is down, when known (missing binary, crash, …). */
	error?: string | null;
}

/** Fired once the server has been restarted and its endpoint re-resolved. */
export const SERVER_RESTARTED_EVENT = 'sidex-server-restarted';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getTauriInvoke(): Invoke | null {
	const g = globalThis as unknown as {
		__TAURI_INVOKE__?: Invoke;
		__TAURI_INTERNALS__?: { invoke: Invoke };
	};
	return g.__TAURI_INVOKE__ ?? g.__TAURI_INTERNALS__?.invoke ?? null;
}

/**
 * Used before the real port is known, and when running outside Tauri. Points at
 * the server's default port (see `sidex-server/cmd/server/main.go`, which binds
 * here whenever `SIDEX_PORT` is unset) so a hand-started server still works in
 * a browser dev session. `running: false` marks it as unconfirmed — callers
 * that need to know whether this is a real answer or just the initial guess
 * should check {@link isServerEndpointResolved} rather than reading the port.
 */
const FALLBACK: IServerEndpoint = {
	wsUrl: 'ws://127.0.0.1:7433',
	httpUrl: 'http://127.0.0.1:7433',
	port: 7433,
	running: false
};

function isValidEndpoint(value: unknown): value is IServerEndpoint {
	// The Rust side is trusted, but a shape check here is what stops a
	// malformed IPC reply from being handed straight to a WebSocket
	// constructor as if it were a real port.
	const ep = value as Partial<IServerEndpoint> | null | undefined;
	return !!ep && typeof ep.wsUrl === 'string' && typeof ep.httpUrl === 'string' && typeof ep.port === 'number' && typeof ep.running === 'boolean';
}

let cached: IServerEndpoint = FALLBACK;
let inFlight: Promise<IServerEndpoint> | null = null;

/**
 * True once `cached` reflects an answer the Rust side actually gave us, as
 * opposed to still being the built-in guess. `running` alone can't carry this
 * distinction — a confirmed "not running" and an unresolved fallback both
 * report `running: false`, and callers need to tell them apart (e.g. to show
 * "server isn't running" only once that's actually known, not while still
 * connecting).
 */
let resolved = false;

/**
 * True once `cached` is a confirmed, live endpoint. Gates the network round
 * trip in {@link resolveServerEndpoint}: once the server has told us it's up
 * there is nothing left to learn until something restarts it, so further
 * calls return the cache instead of re-asking. A "not running" or malformed
 * answer leaves this false so later calls keep retrying.
 */
let settled = false;

/** Apply a raw IPC reply, updating {@link resolved}/{@link settled}/`cached` consistently. */
function applyEndpoint(value: unknown): void {
	if (!isValidEndpoint(value)) {
		// Not a usable answer — leave everything as-is so the caller retries
		// instead of settling on a shape we can't build a URL from.
		return;
	}
	resolved = true;
	// A port of 0 means the supervisor hasn't reserved one yet (or lost it
	// after a failed health check); wsUrl/httpUrl built from that are useless,
	// so don't let it overwrite a real cached endpoint.
	if (value.port > 0) {
		cached = value;
		settled = value.running;
	}
}

/**
 * Last known endpoint. Safe to call synchronously from a property getter;
 * returns the fallback until {@link resolveServerEndpoint} has completed once.
 */
export function getServerEndpoint(): IServerEndpoint {
	return cached;
}

/**
 * Whether `cached` is trustworthy: either the server has confirmed its state
 * (running or not), or there's no Tauri bridge to ask in the first place, so
 * the fallback is the final answer. `false` means still resolving — the chat
 * UI should read that as "connecting", not "disconnected".
 */
export function isServerEndpointResolved(): boolean {
	return resolved || !getTauriInvoke();
}

/**
 * Ask the Rust side where the server is listening. Concurrent callers share one
 * request. A confirmed-running answer is memoized so repeat callers (every
 * chat fetch, every completion request) don't pay for a fresh IPC round trip;
 * anything else — not running yet, or the call itself failing — is treated as
 * unresolved so the next call tries again instead of getting stuck on it.
 */
export function resolveServerEndpoint(): Promise<IServerEndpoint> {
	if (inFlight) {
		return inFlight;
	}
	if (settled) {
		return Promise.resolve(cached);
	}
	const invoke = getTauriInvoke();
	if (!invoke) {
		return Promise.resolve(cached);
	}
	inFlight = invoke('server_endpoint')
		.then(result => {
			applyEndpoint(result);
			return cached;
		})
		// Leave `resolved`/`settled` untouched: a rejected IPC call isn't an
		// answer, just a reason to try again next time.
		.catch(() => cached)
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

/**
 * Restart the server so newly-saved provider credentials are picked up, then
 * refresh the cached endpoint (the port changes across restarts).
 */
export async function restartServer(): Promise<IServerEndpoint> {
	const invoke = getTauriInvoke();
	if (!invoke) {
		return cached;
	}
	let restarted = false;
	try {
		applyEndpoint(await invoke('server_restart'));
		restarted = true;
	} catch {
		// The IPC call itself failed, so unlike a `running: false` reply we
		// have no idea what state the server is in — it may not have been
		// touched at all. Leave the cache as-is and skip the reconnect
		// signal below rather than guessing; the caller surfaces the
		// disconnected state on its own, and normal backoff will retry.
	}
	if (restarted) {
		// `server_restart` always kills the previous process before trying to
		// respawn it, even when the respawn itself fails — so the old socket
		// is dead either way. Tell anyone holding one to reconnect now rather
		// than waiting out an exponential backoff meant for real outages; if
		// the respawn did fail, that reconnect attempt fails fast and falls
		// back to the normal backoff on its own.
		window.dispatchEvent(new CustomEvent(SERVER_RESTARTED_EVENT));
	}
	return cached;
}

/**
 * Resolve the WebSocket origin, honouring an explicit `sidex.chat.serverUrl`
 * override so a user can point the app at a server they run themselves.
 */
export function serverWsUrl(configured: string | undefined): string {
	const trimmed = configured?.trim();
	return trimmed ? trimmed.replace(/\/+$/, '') : cached.wsUrl;
}

/** HTTP form of {@link serverWsUrl}, for plain request/response endpoints. */
export function serverHttpUrl(configured: string | undefined): string {
	const ws = serverWsUrl(configured);
	return ws.replace(/^ws/, 'http');
}
