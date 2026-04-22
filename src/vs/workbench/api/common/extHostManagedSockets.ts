/*---------------------------------------------------------------------------------------------
 *  SideX — ExtHost managed sockets stub. Remote socket multiplexing is handled by the
 *  sidex-remote Rust crate; extension-level factories are accepted but not routed.
 *--------------------------------------------------------------------------------------------*/

import { ExtHostManagedSocketsShape } from './extHost.protocol.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import type * as vscode from 'vscode';
import { VSBuffer } from '../../../base/common/buffer.js';

export interface IExtHostManagedSockets extends ExtHostManagedSocketsShape {
	setFactory(socketFactoryId: number, makeConnection: () => Thenable<vscode.ManagedMessagePassing>): void;
	readonly _serviceBrand: undefined;
}

export const IExtHostManagedSockets = createDecorator<IExtHostManagedSockets>('IExtHostManagedSockets');

export class ExtHostManagedSockets implements IExtHostManagedSockets {
	declare readonly _serviceBrand: undefined;

	setFactory(_socketFactoryId: number, _makeConnection: () => Thenable<vscode.ManagedMessagePassing>): void {}

	async $openRemoteSocket(_socketFactoryId: number): Promise<number> {
		throw new Error('Managed sockets are not supported in SideX');
	}
	$remoteSocketWrite(_socketId: number, _buffer: VSBuffer): void {}
	$remoteSocketEnd(_socketId: number): void {}
	async $remoteSocketDrain(_socketId: number): Promise<void> {}
}
