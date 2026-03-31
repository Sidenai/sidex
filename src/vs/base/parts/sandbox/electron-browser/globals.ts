/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INodeProcess, IProcessEnvironment } from '../../../common/platform.js';
import { ISandboxConfiguration } from '../common/sandboxTypes.js';
import { IpcRenderer, ProcessMemoryInfo, WebFrame, WebUtils } from './electronTypes.js';

/**
 * In the Tauri webview we cannot expose all of the `process` global of node.js,
 * so we expose a compatible subset populated from the preload bridge.
 */
export interface ISandboxNodeProcess extends INodeProcess {

	readonly platform: string;

	readonly arch: string;

	readonly type: string;

	readonly versions: { [key: string]: string | undefined };

	readonly env: IProcessEnvironment;

	readonly execPath: string;

	on: (type: string, callback: Function) => void;

	cwd: () => string;

	getProcessMemoryInfo: () => Promise<ProcessMemoryInfo>;

	shellEnv(): Promise<IProcessEnvironment>;
}

export interface IpcMessagePort {

	acquire(responseChannel: string, nonce: string): void;
}

export interface ISandboxContext {

	configuration(): ISandboxConfiguration | undefined;

	resolveConfiguration(): Promise<ISandboxConfiguration>;
}

interface ISandboxGlobal {
	vscode: {
		readonly ipcRenderer: IpcRenderer;
		readonly ipcMessagePort: IpcMessagePort;
		readonly webFrame: WebFrame;
		readonly process: ISandboxNodeProcess;
		readonly context: ISandboxContext;
		readonly webUtils: WebUtils;
	};
}

const vscodeGlobal = (globalThis as unknown as ISandboxGlobal).vscode;
export const ipcRenderer: IpcRenderer = vscodeGlobal.ipcRenderer;
export const ipcMessagePort: IpcMessagePort = vscodeGlobal.ipcMessagePort;
export const webFrame: WebFrame = vscodeGlobal.webFrame;
export const process: ISandboxNodeProcess = vscodeGlobal.process;
export const context: ISandboxContext = vscodeGlobal.context;
export const webUtils: WebUtils = vscodeGlobal.webUtils;

/**
 * A set of globals only available to main windows that depend
 * on the Tauri preload bridge.
 */
export interface IMainWindowSandboxGlobals {
	readonly ipcRenderer: IpcRenderer;
	readonly ipcMessagePort: IpcMessagePort;
	readonly webFrame: WebFrame;
	readonly process: ISandboxNodeProcess;
	readonly context: ISandboxContext;
	readonly webUtils: WebUtils;
}

/**
 * A set of globals that are available in all windows that either
 * depend on the main preload or the auxiliary preload bridge.
 */
export interface ISandboxGlobals {
	readonly ipcRenderer: Pick<import('./electronTypes.js').IpcRenderer, 'send' | 'invoke'>;
	readonly webFrame: import('./electronTypes.js').WebFrame;
}
