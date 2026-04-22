/*---------------------------------------------------------------------------------------------
 *  SideX — ExtHost terminal shell integration stub. Shell integration is handled by the
 *  Tauri terminal backend; extension subscriptions are accepted but never fire.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { Disposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import type { ExtHostTerminalShellIntegrationShape } from './extHost.protocol.js';
import { TerminalShellExecutionCommandLineConfidence } from './extHostTypes.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { IExtHostTerminalService } from './extHostTerminalService.js';

export interface IExtHostTerminalShellIntegration extends ExtHostTerminalShellIntegrationShape {
	readonly _serviceBrand: undefined;

	readonly onDidChangeTerminalShellIntegration: Event<vscode.TerminalShellIntegrationChangeEvent>;
	readonly onDidStartTerminalShellExecution: Event<vscode.TerminalShellExecutionStartEvent>;
	readonly onDidEndTerminalShellExecution: Event<vscode.TerminalShellExecutionEndEvent>;
}

export const IExtHostTerminalShellIntegration = createDecorator<IExtHostTerminalShellIntegration>(
	'IExtHostTerminalShellIntegration'
);

export class ExtHostTerminalShellIntegration extends Disposable implements IExtHostTerminalShellIntegration {
	readonly _serviceBrand: undefined;

	readonly onDidChangeTerminalShellIntegration = this._register(
		new Emitter<vscode.TerminalShellIntegrationChangeEvent>()
	).event;
	readonly onDidStartTerminalShellExecution = this._register(new Emitter<vscode.TerminalShellExecutionStartEvent>())
		.event;
	readonly onDidEndTerminalShellExecution = this._register(new Emitter<vscode.TerminalShellExecutionEndEvent>()).event;

	constructor(
		@IExtHostRpcService _extHostRpc: IExtHostRpcService,
		@IExtHostTerminalService _extHostTerminalService: IExtHostTerminalService
	) {
		super();
	}

	$shellIntegrationChange(_instanceId: number, _supportsExecuteCommandApi: boolean): void {}
	$shellExecutionStart(
		_instanceId: number,
		_supportsExecuteCommandApi: boolean,
		_commandLineValue: string,
		_commandLineConfidence: TerminalShellExecutionCommandLineConfidence,
		_isTrusted: boolean,
		_cwd: string | undefined
	): void {}
	$shellExecutionEnd(
		_instanceId: number,
		_commandLineValue: string,
		_commandLineConfidence: TerminalShellExecutionCommandLineConfidence,
		_isTrusted: boolean,
		_exitCode: number | undefined
	): void {}
	$shellExecutionData(_instanceId: number, _data: string): void {}
	$shellEnvChange(_instanceId: number, _shellEnvKeys: string[], _shellEnvValues: string[], _isTrusted: boolean): void {}
	$cwdChange(_instanceId: number, _cwd: string | undefined): void {}
	$closeTerminal(_instanceId: number): void {}
}
