/*---------------------------------------------------------------------------------------------
 *  Tauri Terminal Backend for SideX
 *  Bridges VSCode's terminal infrastructure to Tauri's PTY commands.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isWindows, OperatingSystem } from '../../../../base/common/platform.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import {
	IProcessDataEvent,
	IProcessProperty,
	IProcessReadyEvent,
	IShellLaunchConfig,
	ITerminalBackend,
	ITerminalChildProcess,
	ITerminalLaunchError,
	ITerminalProfile,
	ITerminalBackendRegistry,
	TerminalExtensions,
	IPtyHostLatencyMeasurement,
	ITerminalsLayoutInfo,
	ITerminalsLayoutInfoById,
	ITerminalProcessOptions,
	TitleEventSource,
	TerminalIcon,
	ProcessPropertyType,
	IProcessPropertyMap,
	ITerminalLaunchResult
} from '../../../../platform/terminal/common/terminal.js';
import type { IProcessDetails } from '../../../../platform/terminal/common/terminalProcess.js';
import type { IProcessEnvironment } from '../../../../base/common/platform.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITerminalInstanceService, ITerminalService } from './terminal.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
let _listen: ((event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>) | undefined;

async function ensureTauri(): Promise<boolean> {
	if (_invoke && _listen) {
		return true;
	}
	try {
		const core = await import('@tauri-apps/api/core');
		const events = await import('@tauri-apps/api/event');
		_invoke = core.invoke;
		_listen = events.listen as typeof _listen;
		return true;
	} catch (e) {
		console.error('[SideX Terminal] Failed to load Tauri APIs:', e);
		return false;
	}
}

function getShellBasename(shellPath: string): string {
	return (
		shellPath
			.split(/[\\/]/)
			.pop()
			?.replace(/\.exe$/i, '') || 'zsh'
	);
}

let nextPtyId = 1;

class TauriPty extends Disposable implements ITerminalChildProcess {
	readonly id: number;
	readonly shouldPersist = false;

	private readonly _onProcessData = this._register(new Emitter<IProcessDataEvent | string>());
	readonly onProcessData = this._onProcessData.event;

	private readonly _onProcessReady = this._register(new Emitter<IProcessReadyEvent>());
	readonly onProcessReady = this._onProcessReady.event;

	private readonly _onDidChangeProperty = this._register(new Emitter<IProcessProperty<any>>());
	readonly onDidChangeProperty = this._onDidChangeProperty.event;

	private readonly _onProcessExit = this._register(new Emitter<number | undefined>());
	readonly onProcessExit = this._onProcessExit.event;

	private _backendId: number | undefined;
	private _unlisten: (() => void) | undefined;
	private _unlistenExit: (() => void) | undefined;

	constructor(
		private readonly _shellLaunchConfig: IShellLaunchConfig,
		private readonly _cwd: string,
		private _cols: number,
		private _rows: number,
		private readonly _env?: IProcessEnvironment
	) {
		super();
		this.id = nextPtyId++;
	}

	async start(): Promise<ITerminalLaunchError | ITerminalLaunchResult | undefined> {
		const ok = await ensureTauri();
		if (!ok || !_invoke || !_listen) {
			return { message: 'Tauri APIs not available' };
		}

		try {
			const shell = this._shellLaunchConfig.executable || undefined;
			const args = this._shellLaunchConfig.args;

			const envToPass: Record<string, string> = {};
			if (this._env) {
				for (const [k, v] of Object.entries(this._env)) {
					if (v !== undefined && v !== null) {
						envToPass[k] = String(v);
					}
				}
			}
			envToPass['TERM'] = 'xterm-256color';
			envToPass['COLORTERM'] = 'truecolor';
			envToPass['TERM_PROGRAM'] = 'SideX';
			if (!envToPass['LANG']) {
				envToPass['LANG'] = 'en_US.UTF-8';
			}

			// Pass args from shell launch config; Rust will add -l if none provided
			let shellArgs: string[] | undefined;
			if (Array.isArray(args)) {
				shellArgs = args as string[];
			} else if (typeof args === 'string') {
				shellArgs = [args];
			}
			const shellBasename = shell ? shell.split('/').pop() || '' : '';

			const dataBuffer: string[] = [];
			let attached = false;

			this._unlisten = await _listen('terminal-data', event => {
				const payload = event.payload as { terminal_id: number; data: string };
				if (this._backendId !== undefined && payload.terminal_id === this._backendId) {
					if (attached) {
						this._onProcessData.fire(payload.data);
					} else {
						dataBuffer.push(payload.data);
					}
				}
			});

			this._unlistenExit = await _listen('terminal-exit', event => {
				const payload = event.payload as { terminal_id: number; exit_code: number };
				if (this._backendId !== undefined && payload.terminal_id === this._backendId) {
					this._onProcessExit.fire(payload.exit_code);
				}
			});

			const backendId = (await _invoke('terminal_spawn', {
				shell: shell ?? null,
				args: shellArgs ?? null,
				cwd: this._cwd || null,
				env: Object.keys(envToPass).length > 0 ? envToPass : null,
				cols: this._cols,
				rows: this._rows
			})) as number;
			this._backendId = backendId;

			attached = true;
			for (const data of dataBuffer) {
				this._onProcessData.fire(data);
			}
			dataBuffer.length = 0;

			let pid = backendId;
			try {
				pid = (await _invoke('terminal_get_pid', { terminalId: backendId })) as number;
			} catch {}

			this._onProcessReady.fire({ pid, cwd: this._cwd, windowsPty: undefined });
			this._onDidChangeProperty.fire({ type: ProcessPropertyType.InitialCwd, value: this._cwd });

			const shellName = shellBasename || 'terminal';
			this._onDidChangeProperty.fire({
				type: ProcessPropertyType.Title,
				value: shellName
			} as IProcessProperty<ProcessPropertyType.Title>);

			return undefined;
		} catch (e: any) {
			console.error('[SideX Terminal] Failed to spawn:', e);
			return { message: e?.message || 'Failed to spawn terminal' };
		}
	}

	shutdown(_immediate: boolean): void {
		try {
			if (this._backendId !== undefined && _invoke) {
				_invoke('terminal_kill', { terminalId: this._backendId }).catch(() => {});
			}
			this._unlisten?.();
			this._unlistenExit?.();
		} catch {
			// IPC channel may already be closed during page unload
		}
		this._unlisten = undefined;
		this._unlistenExit = undefined;
	}

	input(data: string): void {
		if (this._backendId !== undefined && _invoke) {
			_invoke('terminal_write', { terminalId: this._backendId, data }).catch(() => {});
		}
	}

	resize(cols: number, rows: number): void {
		this._cols = cols;
		this._rows = rows;
		if (this._backendId !== undefined && _invoke) {
			_invoke('terminal_resize', { terminalId: this._backendId, cols, rows }).catch(() => {});
		}
	}

	acknowledgeDataEvent(_charCount: number): void {}
	async processBinary(_data: string): Promise<void> {}
	async getInitialCwd(): Promise<string> {
		return this._cwd;
	}
	async getCwd(): Promise<string> {
		return this._cwd;
	}
	sendSignal(_signal: string): void {}
	clearBuffer(): void {}
	async setUnicodeVersion(_version: '6' | '11'): Promise<void> {}

	async refreshProperty<T extends ProcessPropertyType>(property: T): Promise<IProcessPropertyMap[T]> {
		if (property === ProcessPropertyType.Cwd || property === ProcessPropertyType.InitialCwd) {
			return this._cwd as IProcessPropertyMap[T];
		}
		throw new Error(`Unhandled property: ${property}`);
	}

	async updateProperty<T extends ProcessPropertyType>(_property: T, _value: IProcessPropertyMap[T]): Promise<void> {}

	override dispose(): void {
		this.shutdown(true);
		super.dispose();
	}
}

class TauriTerminalBackend extends Disposable implements ITerminalBackend {
	readonly remoteAuthority = undefined;
	readonly isResponsive = true;

	private readonly _whenReadyPromise: Promise<void>;
	private _resolveReady!: () => void;

	get whenReady(): Promise<void> {
		return this._whenReadyPromise;
	}

	private readonly _onPtyHostUnresponsive = this._register(new Emitter<void>());
	readonly onPtyHostUnresponsive = this._onPtyHostUnresponsive.event;
	private readonly _onPtyHostResponsive = this._register(new Emitter<void>());
	readonly onPtyHostResponsive = this._onPtyHostResponsive.event;
	private readonly _onPtyHostRestart = this._register(new Emitter<void>());
	readonly onPtyHostRestart = this._onPtyHostRestart.event;
	private readonly _onDidRequestDetach = this._register(
		new Emitter<{ requestId: number; workspaceId: string; instanceId: number }>()
	);
	readonly onDidRequestDetach = this._onDidRequestDetach.event;

	constructor() {
		super();
		this._whenReadyPromise = new Promise<void>(resolve => {
			this._resolveReady = resolve;
		});
		this._init();
	}

	private async _init(): Promise<void> {
		await ensureTauri();
		this._resolveReady();
	}

	setReady(): void {
		this._resolveReady();
	}

	async createProcess(
		shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		cols: number,
		rows: number,
		_unicodeVersion: '6' | '11',
		_env: IProcessEnvironment,
		_options: ITerminalProcessOptions,
		_shouldPersist: boolean
	): Promise<ITerminalChildProcess> {
		if (!shellLaunchConfig.executable) {
			const defaultShell = await this.getDefaultSystemShell();
			shellLaunchConfig.executable = defaultShell;
		}
		let resolvedCwd = cwd;
		if (!resolvedCwd) {
			const env = await this.getEnvironment();
			resolvedCwd = env['HOME'] || '/';
		}
		return new TauriPty(shellLaunchConfig, resolvedCwd, cols, rows, _env);
	}

	async attachToProcess(_id: number): Promise<ITerminalChildProcess | undefined> {
		return undefined;
	}
	async attachToRevivedProcess(_id: number): Promise<ITerminalChildProcess | undefined> {
		return undefined;
	}
	async listProcesses(): Promise<IProcessDetails[]> {
		return [];
	}
	async getLatency(): Promise<IPtyHostLatencyMeasurement[]> {
		return [];
	}

	async getDefaultSystemShell(_osOverride?: OperatingSystem): Promise<string> {
		await ensureTauri();
		if (_invoke) {
			try {
				const shell = (await _invoke('get_default_shell')) as string;
				if (shell) {
					return shell;
				}
			} catch {}
		}
		return '/bin/zsh';
	}

	async getProfiles(
		_profiles: unknown,
		_defaultProfile: unknown,
		_includeDetectedProfiles?: boolean
	): Promise<ITerminalProfile[]> {
		const defaultShell = await this.getDefaultSystemShell();
		const defaultName = getShellBasename(defaultShell);

		await ensureTauri();

		const iconMap: Record<string, ThemeIcon> = {
			zsh: Codicon.terminal,
			bash: Codicon.terminalBash,
			fish: Codicon.terminal,
			sh: Codicon.terminalLinux,
			pwsh: Codicon.terminalPowershell,
			powershell: Codicon.terminalPowershell
		};

		interface ShellInfoResult {
			name: string;
			path: string;
			is_default: boolean;
		}

		let detectedShells: ShellInfoResult[] = [];
		if (_invoke) {
			try {
				detectedShells = (await _invoke('get_available_shells', {})) as ShellInfoResult[];
			} catch {
				// Fallback: check shells individually
			}
		}

		if (detectedShells.length > 0) {
			const profiles: ITerminalProfile[] = [];
			const seen = new Set<string>();
			let hasDefaultProfile = false;

			for (const shell of detectedShells) {
				if (seen.has(shell.name)) {
					continue;
				}
				seen.add(shell.name);
				const shellBaseName = getShellBasename(shell.path);
				const isDefault = shell.is_default || shellBaseName === defaultName;
				hasDefaultProfile = hasDefaultProfile || isDefault;
				profiles.push({
					profileName: shell.name,
					path: shell.path,
					isDefault,
					isAutoDetected: false,
					icon: iconMap[shellBaseName] || iconMap[shell.name] || Codicon.terminal
				});
			}

			if (!hasDefaultProfile) {
				profiles.unshift({
					profileName: defaultName,
					path: defaultShell,
					isDefault: true,
					isAutoDetected: false,
					icon: iconMap[defaultName] || Codicon.terminal
				});
			}

			return profiles;
		}

		// Fallback: check each shell path individually via Rust
		const knownShells: { path: string; profileName: string }[] = [
			{ path: '/bin/zsh', profileName: 'zsh' },
			{ path: '/bin/bash', profileName: 'bash' },
			{ path: '/usr/bin/fish', profileName: 'fish' },
			{ path: '/usr/local/bin/fish', profileName: 'fish' },
			{ path: '/opt/homebrew/bin/fish', profileName: 'fish' },
			{ path: '/bin/sh', profileName: 'sh' }
		];

		const profiles: ITerminalProfile[] = [];
		const seen = new Set<string>();

		for (const shell of knownShells) {
			if (seen.has(shell.profileName)) {
				continue;
			}

			let exists = false;
			if (_invoke) {
				try {
					exists = (await _invoke('check_shell_exists', { path: shell.path })) as boolean;
				} catch {
					exists = false;
				}
			}

			if (!exists) {
				continue;
			}

			seen.add(shell.profileName);
			profiles.push({
				profileName: shell.profileName,
				path: shell.path,
				isDefault: shell.profileName === defaultName,
				isAutoDetected: false,
				icon: iconMap[shell.profileName] || Codicon.terminal
			});
		}

		if (!seen.has(defaultName)) {
			profiles.unshift({
				profileName: defaultName,
				path: defaultShell,
				isDefault: true,
				isAutoDetected: false,
				icon: iconMap[defaultName] || Codicon.terminal
			});
		}

		return profiles;
	}

	async getWslPath(original: string, _direction: 'unix-to-win' | 'win-to-unix'): Promise<string> {
		return original;
	}

	async getEnvironment(): Promise<IProcessEnvironment> {
		await ensureTauri();
		if (_invoke) {
			try {
				return (await _invoke('get_all_env')) as IProcessEnvironment;
			} catch {
				// Fall through to an empty environment if invoke is unavailable.
			}
		}
		return {};
	}
	async getShellEnvironment(): Promise<IProcessEnvironment | undefined> {
		return this.getEnvironment();
	}
	async setTerminalLayoutInfo(_layoutInfo?: ITerminalsLayoutInfoById): Promise<void> {}
	async updateTitle(_id: number, _title: string, _titleSource: TitleEventSource): Promise<void> {}
	async updateIcon(_id: number, _userInitiated: boolean, _icon: TerminalIcon, _color?: string): Promise<void> {}
	async setNextCommandId(_id: number, _commandLine: string, _commandId: string): Promise<void> {}
	async getTerminalLayoutInfo(): Promise<ITerminalsLayoutInfo | undefined> {
		return undefined;
	}
	async getPerformanceMarks(): Promise<any[]> {
		return [];
	}
	async reduceConnectionGraceTime(): Promise<void> {}
	async requestDetachInstance(_workspaceId: string, _instanceId: number): Promise<IProcessDetails | undefined> {
		return undefined;
	}
	async acceptDetachInstanceReply(_requestId: number, _persistentProcessId?: number): Promise<void> {}
	async persistTerminalState(): Promise<void> {}
	restartPtyHost(): void {}

	async installAutoReply(_match: string, _reply: string): Promise<void> {}
	async uninstallAllAutoReplies(): Promise<void> {}
	async getAutoReplies(): Promise<Map<string, string>> {
		return new Map();
	}
}

export class TauriTerminalBackendContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.tauriTerminalBackend';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService,
		@ITerminalService terminalService: ITerminalService,
		@IConfigurationService configurationService: IConfigurationService
	) {
		if (!(globalThis as any).__SIDEX_TAURI__) {
			return;
		}

		const backend = new TauriTerminalBackend();
		Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend).registerTerminalBackend(backend);
		terminalInstanceService.didRegisterBackend(backend);
		terminalService.registerProcessSupport(true);

		this._setDefaultProfile(backend, configurationService);
	}

	private async _setDefaultProfile(
		backend: TauriTerminalBackend,
		configurationService: IConfigurationService
	): Promise<void> {
		const platformKey = isMacintosh ? 'osx' : isWindows ? 'windows' : 'linux';
		const configKey = `terminal.integrated.defaultProfile.${platformKey}`;
		const current = configurationService.getValue<string>(configKey);
		if (!current) {
			const shell = await backend.getDefaultSystemShell();
			const name = shell.split('/').pop() || 'zsh';
			configurationService.updateValue(configKey, name);
		}
	}
}

registerWorkbenchContribution2(
	TauriTerminalBackendContribution.ID,
	TauriTerminalBackendContribution,
	WorkbenchPhase.BlockStartup
);
