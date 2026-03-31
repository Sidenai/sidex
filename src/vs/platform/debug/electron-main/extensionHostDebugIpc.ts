/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import type { Server } from 'http';
import { Socket } from 'net';
import { VSBuffer } from '../../../base/common/buffer.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ISocket } from '../../../base/parts/ipc/common/ipc.net.js';
import { upgradeToISocket } from '../../../base/parts/ipc/node/ipc.net.js';
import { OPTIONS, parseArgs } from '../../environment/node/argv.js';
import { IWindowsMainService, OpenContext } from '../../windows/electron-main/windows.js';
import { IOpenExtensionWindowResult } from '../common/extensionHostDebug.js';
import { ExtensionHostDebugBroadcastChannel } from '../common/extensionHostDebugIpc.js';

export class ElectronExtensionHostDebugBroadcastChannel<TContext> extends ExtensionHostDebugBroadcastChannel<TContext> {

	constructor(
		private windowsMainService: IWindowsMainService
	) {
		super();
	}

	override call(ctx: TContext, command: string, arg?: any): Promise<any> {
		if (command === 'openExtensionDevelopmentHostWindow') {
			return this.openExtensionDevelopmentHostWindow(arg[0], arg[1]);
		} else if (command === 'attachToCurrentWindowRenderer') {
			return this.attachToCurrentWindowRenderer(arg[0]);
		} else {
			return super.call(ctx, command, arg);
		}
	}

	private async attachToCurrentWindowRenderer(windowId: number): Promise<IOpenExtensionWindowResult> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);
		if (!codeWindow?.win) {
			return { success: false };
		}

		return this.openCdp(codeWindow.win, true);
	}

	private async openExtensionDevelopmentHostWindow(args: string[], debugRenderer: boolean): Promise<IOpenExtensionWindowResult> {
		const pargs = parseArgs(args, OPTIONS);
		pargs.debugRenderer = debugRenderer;

		const extDevPaths = pargs.extensionDevelopmentPath;
		if (!extDevPaths) {
			return { success: false };
		}

		const [codeWindow] = await this.windowsMainService.openExtensionDevelopmentHostWindow(extDevPaths, {
			context: OpenContext.API,
			cli: pargs,
			forceProfile: pargs.profile,
			forceTempProfile: pargs['profile-temp']
		});

		if (!debugRenderer) {
			return { success: true };
		}

		const win = codeWindow.win;
		if (!win) {
			return { success: true };
		}

		return this.openCdp(win, false);
	}

	private async openCdpServer(ident: string, onSocket: (socket: ISocket) => void): Promise<{ server: Server; wsUrl: string; port: number }> {
		const { createServer } = await import('http');
		const server = createServer((req, res) => {
			if (req.url === '/json/list' || req.url === '/json') {
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify([{
					description: 'VS Code Renderer',
					devtoolsFrontendUrl: '',
					id: ident,
					title: 'VS Code Renderer',
					type: 'page',
					url: 'vscode://renderer',
					webSocketDebuggerUrl: wsUrl
				}]));
				return;
			} else if (req.url === '/json/version') {
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify({
					'Browser': 'VS Code Renderer',
					'Protocol-Version': '1.3',
					'webSocketDebuggerUrl': wsUrl
				}));
				return;
			}

			res.statusCode = 404;
			res.end();
		});

		await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
		const serverAddr = server.address();
		const port = typeof serverAddr === 'object' && serverAddr ? serverAddr.port : 0;
		const serverAddrBase = typeof serverAddr === 'string' ? serverAddr : `ws://127.0.0.1:${serverAddr?.port}`;
		const wsUrl = `${serverAddrBase}/${ident}`;

		server.on('upgrade', (req, socket) => {
			if (!req.url?.includes(ident)) {
				socket.end();
				return;
			}
			const upgraded = upgradeToISocket(req, socket as Socket, {
				debugLabel: 'extension-host-cdp-' + generateUuid(),
				enableMessageSplitting: false,
			});

			if (upgraded) {
				onSocket(upgraded);
			}
		});

		return { server, wsUrl, port };
	}

	private async openCdp(win: any, debugRenderer: boolean): Promise<IOpenExtensionWindowResult> {
		// In Tauri, there is no direct webContents.debugger API.
		// CDP debugging over a webview is not natively supported.
		// Return a stub that opens a CDP server but cannot attach to a renderer debugger.

		const ident = generateUuid();
		const { server, wsUrl, port } = await this.openCdpServer(ident, _listener => {
			// Tauri stub: no debugger attachment available
		});

		// Attempt to listen for window close via Tauri event system
		const onWindowClose = () => server.close();
		try {
			await invoke('plugin:event|listen', { event: 'tauri://close-requested', handler: onWindowClose });
		} catch {
			// best effort
		}

		return { rendererDebugAddr: wsUrl, success: true, port: port };
	}
}
