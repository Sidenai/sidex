/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-globals */

/**
 * Preload script for pages loaded in Integrated Browser (Tauri variant)
 *
 * In Electron this ran in an "isolated world" (worldId 999) using
 * `contextBridge.exposeInIsolatedWorld`. Under Tauri the webview already
 * enforces origin-level isolation, so we simply attach the API object to
 * `window` and use `__TAURI__.core.invoke()` to forward unhandled
 * keyboard events to the Rust host process.
 */
(function () {

	type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

	const tauriInvoke: TauriInvoke | undefined =
		(globalThis as any).__TAURI__?.core?.invoke;

	// #######################################################################
	// ###                                                                 ###
	// ###       !!! DO NOT USE GET/SET PROPERTIES ANYWHERE HERE !!!       ###
	// ###       !!!  UNLESS THE ACCESS IS WITHOUT SIDE EFFECTS  !!!       ###
	// ###                                                                 ###
	// #######################################################################

	// Listen for keydown events that the page did not handle and forward them for shortcut handling.
	window.addEventListener('keydown', (event) => {
		// Require that the event is trusted -- i.e. user-initiated.
		// eslint-disable-next-line no-restricted-syntax
		if (!(event instanceof KeyboardEvent) || !event.isTrusted) {
			return;
		}

		// If the event was already handled by the page, do not forward it.
		if (event.defaultPrevented) {
			return;
		}

		const isNonEditingKey =
			event.key === 'Escape' ||
			/^F\d+$/.test(event.key) ||
			event.key.startsWith('Audio') || event.key.startsWith('Media') || event.key.startsWith('Browser');

		// Only forward if there's a command modifier or it's a non-editing key
		// (most plain key events should just be handled natively by the browser and not forwarded)
		if (!(event.ctrlKey || event.altKey || event.metaKey) && !isNonEditingKey) {
			return;
		}

		const isMac = navigator.platform.indexOf('Mac') >= 0;

		// Alt+Key special character handling (Alt + Numpad keys on Windows/Linux, Alt + any key on Mac)
		if (event.altKey && !event.ctrlKey && !event.metaKey) {
			if (isMac || /^Numpad\d+$/.test(event.code)) {
				return;
			}
		}

		// Allow native shortcuts (copy, paste, cut, undo, redo, select all) to be handled by the browser
		const ctrlCmd = isMac ? event.metaKey : event.ctrlKey;
		if (ctrlCmd && !event.altKey) {
			const key = event.key.toLowerCase();
			if (!event.shiftKey && (key === 'a' || key === 'c' || key === 'v' || key === 'x' || key === 'z')) {
				return;
			}
			if (event.shiftKey && (key === 'v' || key === 'z')) {
				return;
			}
			// Ctrl+Y is redo on Windows/Linux
			if (!event.shiftKey && key === 'y' && !isMac) {
				return;
			}
		}

		// Everything else should be forwarded to the workbench for potential shortcut handling.
		event.preventDefault();
		event.stopPropagation();

		const payload = {
			key: event.key,
			keyCode: event.keyCode,
			code: event.code,
			ctrlKey: event.ctrlKey,
			shiftKey: event.shiftKey,
			altKey: event.altKey,
			metaKey: event.metaKey,
			repeat: event.repeat
		};

		if (tauriInvoke) {
			tauriInvoke('browser_view_keydown', payload);
		}
	});

	const globals = {
		/**
		 * Get the currently selected text in the page.
		 */
		getSelectedText(): string {
			try {
				return window.getSelection()?.toString() ?? '';
			} catch {
				return '';
			}
		}
	};

	try {
		// In Tauri, webview contexts are already isolated by origin.
		// Expose the API directly on the window object; the host reads
		// it via webview JS evaluation.
		Object.defineProperty(window, 'browserViewAPI', {
			value: Object.freeze(globals),
			writable: false,
			enumerable: false,
			configurable: false,
		});
	} catch (error) {
		console.error(error);
	}
}());
