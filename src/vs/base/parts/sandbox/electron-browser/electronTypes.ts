/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// #######################################################################
// ###                                                                 ###
// ###   Tauri-compatible type definitions that mirror the Electron    ###
// ###   types previously used. These maintain the same interfaces     ###
// ###   so consumers don't need to change their type imports.         ###
// ###                                                                 ###
// #######################################################################

type Event<Params extends object = {}> = {
	preventDefault: () => void;
	readonly defaultPrevented: boolean;
} & Params;

export interface IpcRendererEvent extends Event {
	sender: IpcRenderer;
}

export interface IpcRenderer {
	invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	on(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): this;
	once(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): this;
	removeListener(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): this;
	send(channel: string, ...args: unknown[]): void;
}

export interface WebFrame {
	setZoomLevel(level: number): void;
}

export interface ProcessMemoryInfo {
	private: number;
	residentSet: number;
	shared: number;
}

export interface AuthInfo {
	isProxy: boolean;
	scheme: string;
	host: string;
	port: number;
	realm: string;
}

export interface WebUtils {
	getPathForFile(file: File): string;
}
