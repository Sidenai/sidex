/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { IProcessEnvironment, isWindows } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { ILogService, LogLevel } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { FlowControlConstants, IShellLaunchConfig, ITerminalChildProcess, ITerminalLaunchError, IProcessProperty, IProcessPropertyMap, ProcessPropertyType, TerminalShellType, IProcessReadyEvent, ITerminalProcessOptions, PosixShellType, IProcessReadyWindowsPty, GeneralShellType, ITerminalLaunchResult } from '../common/terminal.js';

const posixShellTypeMap = new Map<string, PosixShellType>([
	['bash', PosixShellType.Bash],
	['csh', PosixShellType.Csh],
	['fish', PosixShellType.Fish],
	['ksh', PosixShellType.Ksh],
	['sh', PosixShellType.Sh],
	['zsh', PosixShellType.Zsh]
]);

const generalShellTypeMap = new Map<string, GeneralShellType>([
	['pwsh', GeneralShellType.PowerShell],
	['powershell', GeneralShellType.PowerShell],
	['python', GeneralShellType.Python],
	['julia', GeneralShellType.Julia],
	['nu', GeneralShellType.NuShell],
	['node', GeneralShellType.Node],
	['xonsh', GeneralShellType.Xonsh],
]);

export class TerminalProcess extends Disposable implements ITerminalChildProcess {
	readonly id = 0;
	readonly shouldPersist = false;

	private _properties: IProcessPropertyMap = {
		cwd: '',
		initialCwd: '',
		fixedDimensions: { cols: undefined, rows: undefined },
		title: '',
		shellType: undefined,
		hasChildProcesses: true,
		resolvedShellLaunchConfig: {},
		overrideDimensions: undefined,
		failedShellIntegrationActivation: false,
		usedShellIntegrationInjection: undefined,
		shellIntegrationInjectionFailureReason: undefined,
	};

	private _exitCode: number | undefined;
	private _exitMessage: string | undefined;
	private _currentTitle: string = '';
	private _processStartupComplete: Promise<void> | undefined;
	private readonly _initialCwd: string;
	private _ptyId: string | undefined;
	private _dataUnlisten: UnlistenFn | undefined;
	private _exitUnlisten: UnlistenFn | undefined;

	get exitMessage(): string | undefined { return this._exitMessage; }
	get currentTitle(): string { return this._currentTitle; }
	get shellType(): TerminalShellType | undefined { return posixShellTypeMap.get(this._currentTitle) || generalShellTypeMap.get(this._currentTitle); }
	get hasChildProcesses(): boolean { return true; }

	private readonly _onProcessData = this._register(new Emitter<string>());
	readonly onProcessData = this._onProcessData.event;
	private readonly _onProcessReady = this._register(new Emitter<IProcessReadyEvent>());
	readonly onProcessReady = this._onProcessReady.event;
	private readonly _onDidChangeProperty = this._register(new Emitter<IProcessProperty>());
	readonly onDidChangeProperty = this._onDidChangeProperty.event;
	private readonly _onProcessExit = this._register(new Emitter<number>());
	readonly onProcessExit = this._onProcessExit.event;

	constructor(
		readonly shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		private _cols: number,
		private _rows: number,
		private _env: IProcessEnvironment,
		private readonly _executableEnv: IProcessEnvironment,
		private readonly _options: ITerminalProcessOptions,
		@ILogService private readonly _logService: ILogService,
		@IProductService private readonly _productService: IProductService
	) {
		super();
		this._initialCwd = cwd;
		this._properties[ProcessPropertyType.InitialCwd] = this._initialCwd;
		this._properties[ProcessPropertyType.Cwd] = this._initialCwd;
	}

	async start(): Promise<ITerminalLaunchResult | undefined> {
		const executable = this.shellLaunchConfig.executable;
		if (!executable) {
			return { message: 'No executable specified' };
		}

		try {
			const result = await invoke<{ pty_id: string; pid: number }>('terminal_spawn', {
				executable,
				args: this.shellLaunchConfig.args || [],
				cwd: this._initialCwd,
				env: this._env,
				cols: this._cols,
				rows: this._rows,
			});

			this._ptyId = result.pty_id;
			this._currentTitle = path.basename(executable);

			this._dataUnlisten = await listen<string>(`terminal-data-${this._ptyId}`, (event) => {
				this._onProcessData.fire(event.payload);
			});

			this._exitUnlisten = await listen<number>(`terminal-exit-${this._ptyId}`, (event) => {
				this._exitCode = event.payload;
				this._onProcessExit.fire(event.payload);
			});

			this._onProcessReady.fire({
				pid: result.pid,
				cwd: this._initialCwd,
				requiresWindowsMode: false,
			});

			return undefined;
		} catch (error: any) {
			return { message: String(error) };
		}
	}

	async shutdown(immediate: boolean): Promise<void> {
		if (this._ptyId) {
			try {
				await invoke('terminal_kill', { ptyId: this._ptyId, immediate });
			} catch {
				// ignore
			}
		}
	}

	input(data: string): void {
		if (this._ptyId) {
			invoke('terminal_write', { ptyId: this._ptyId, data }).catch(() => {});
		}
	}

	resize(cols: number, rows: number): void {
		this._cols = cols;
		this._rows = rows;
		if (this._ptyId) {
			invoke('terminal_resize', { ptyId: this._ptyId, cols, rows }).catch(() => {});
		}
	}

	async processBinary(_data: string): Promise<void> {
		// TODO: Binary data support via Tauri
	}

	acknowledgeDataEvent(_charCount: number): void {
		// Flow control acknowledgement
	}

	async setUnicodeVersion(_version: '6' | '11'): Promise<void> {
		// TODO: Unicode version support
	}

	async getInitialCwd(): Promise<string> {
		return this._initialCwd;
	}

	async getCwd(): Promise<string> {
		if (this._ptyId) {
			try {
				return await invoke<string>('terminal_get_cwd', { ptyId: this._ptyId });
			} catch {
				return this._initialCwd;
			}
		}
		return this._initialCwd;
	}

	async getLatency(): Promise<number> {
		return 0;
	}

	getProperties(): IProcessPropertyMap {
		return this._properties;
	}

	override dispose(): void {
		this._dataUnlisten?.();
		this._exitUnlisten?.();
		this.shutdown(true);
		super.dispose();
	}
}
