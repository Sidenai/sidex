/*---------------------------------------------------------------------------------------------
 *  SideX — Low-level Tauri IPC bridge.
 *  Wraps `window.__TAURI__` with a graceful fallback when running outside
 *  the Tauri webview (e.g. in a plain browser during development).
 *--------------------------------------------------------------------------------------------*/

declare global {
	interface Window {
		__TAURI__?: {
			core?: {
				invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
			};
		};
		__TAURI_INTERNALS__?: {
			invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
		};
		__TAURI_INVOKE__?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
	}
}

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

function getInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
	if (_invoke) {
		return _invoke;
	}
	const g = (typeof window !== 'undefined' ? window : (globalThis as any)) as Window;
	if (g.__TAURI_INTERNALS__?.invoke) {
		_invoke = (cmd, args) => g.__TAURI_INTERNALS__!.invoke(cmd, args);
		return _invoke;
	}
	if (typeof g.__TAURI_INVOKE__ === 'function') {
		_invoke = g.__TAURI_INVOKE__;
		return _invoke;
	}
	if (window.__TAURI__?.core?.invoke) {
		_invoke = window.__TAURI__.core.invoke;
		return _invoke;
	}
	return null;
}

export async function invoke<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
	const fn = getInvoke();
	if (!fn) {
		console.warn(`[SideX] invoke(${cmd}) — Tauri not available`);
		return null as unknown as T;
	}
	return fn(cmd, args) as Promise<T>;
}

export function isTauri(): boolean {
	return !!getInvoke();
}
