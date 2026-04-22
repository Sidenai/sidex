/*---------------------------------------------------------------------------------------------
 *  Tauri-specific extension host debug service.
 *  Replaces Node.js process spawning with Tauri IPC commands.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	createCancelablePromise,
	disposableTimeout,
	firstParallel,
	RunOnceScheduler,
	timeout
} from '../../../base/common/async.js';
import { DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import * as platform from '../../../base/common/platform.js';
import * as nls from '../../../nls.js';
import { ISignService } from '../../../platform/sign/common/sign.js';
import { AbstractDebugAdapter } from '../../contrib/debug/common/abstractDebugAdapter.js';
import { TauriExecutableDebugAdapter, TauriSocketDebugAdapter } from '../../contrib/debug/tauri/tauriDebugAdapter.js';
import { ExtensionDescriptionRegistry } from '../../services/extensions/common/extensionDescriptionRegistry.js';
import { IExtHostCommands } from '../common/extHostCommands.js';
import { IExtHostConfiguration } from '../common/extHostConfiguration.js';
import { ExtHostDebugServiceBase, ExtHostDebugSession } from '../common/extHostDebugService.js';
import { IExtHostEditorTabs } from '../common/extHostEditorTabs.js';
import { IExtHostExtensionService } from '../common/extHostExtensionService.js';
import { IExtHostRpcService } from '../common/extHostRpcService.js';
import { IExtHostTerminalService } from '../common/extHostTerminalService.js';
import { IExtHostTesting } from '../common/extHostTesting.js';
import {
	DebugAdapterExecutable,
	DebugAdapterNamedPipeServer,
	DebugAdapterServer,
	ThemeIcon
} from '../common/extHostTypes.js';
import { IExtHostVariableResolverProvider } from '../common/extHostVariableResolverService.js';
import { IExtHostWorkspace } from '../common/extHostWorkspace.js';
import { IExtHostTerminalShellIntegration } from '../common/extHostTerminalShellIntegration.js';
import { IDebugAdapterExecutable } from '../../contrib/debug/common/debug.js';

export class ExtHostDebugService extends ExtHostDebugServiceBase {
	private _integratedTerminalInstances = new DebugTerminalCollection();
	private _terminalDisposedListener: IDisposable | undefined;

	constructor(
		@IExtHostRpcService extHostRpcService: IExtHostRpcService,
		@IExtHostWorkspace workspaceService: IExtHostWorkspace,
		@IExtHostExtensionService extensionService: IExtHostExtensionService,
		@IExtHostConfiguration configurationService: IExtHostConfiguration,
		@IExtHostTerminalService private _terminalService: IExtHostTerminalService,
		@IExtHostTerminalShellIntegration private _terminalShellIntegrationService: IExtHostTerminalShellIntegration,
		@IExtHostEditorTabs editorTabs: IExtHostEditorTabs,
		@IExtHostVariableResolverProvider variableResolver: IExtHostVariableResolverProvider,
		@IExtHostCommands commands: IExtHostCommands,
		@IExtHostTesting testing: IExtHostTesting
	) {
		super(
			extHostRpcService,
			workspaceService,
			extensionService,
			configurationService,
			editorTabs,
			variableResolver,
			commands,
			testing
		);
	}

	protected override createDebugAdapter(
		adapter: vscode.DebugAdapterDescriptor,
		session: ExtHostDebugSession
	): AbstractDebugAdapter | undefined {
		if (adapter instanceof DebugAdapterExecutable) {
			const dto = this.convertExecutableToDto(adapter);
			return new TauriExecutableDebugAdapter(dto, session.type);
		} else if (adapter instanceof DebugAdapterServer) {
			const dto = this.convertServerToDto(adapter);
			return new TauriSocketDebugAdapter(dto.port, dto.host);
		} else if (adapter instanceof DebugAdapterNamedPipeServer) {
			// Named pipes are not available in Tauri/browser; fall through to base
			return super.createDebugAdapter(adapter, session);
		} else {
			return super.createDebugAdapter(adapter, session);
		}
	}

	protected override daExecutableFromPackage(
		session: ExtHostDebugSession,
		extensionRegistry: ExtensionDescriptionRegistry
	): DebugAdapterExecutable | undefined {
		const desc = this._resolveAdapterExecutable(extensionRegistry.getAllExtensionDescriptions(), session.type);
		if (desc) {
			return new DebugAdapterExecutable(desc.command, desc.args, desc.options);
		}
		return undefined;
	}

	private _resolveAdapterExecutable(
		extensions: readonly import('../../../platform/extensions/common/extensions.js').IExtensionDescription[],
		debugType: string
	): IDebugAdapterExecutable | undefined {
		// Inline platform adapter resolution (mirrors ExecutableDebugAdapter.platformAdapterExecutable)
		// without requiring Node.js modules
		debugType = debugType.toLowerCase();
		let program: string | undefined;
		let cmdArgs: string[] | undefined;
		let runtime: string | undefined;
		let runtimeArgs: string[] | undefined;

		for (const ext of extensions) {
			if (!ext.contributes) {
				continue;
			}
			const debuggers = (ext.contributes as Record<string, unknown>)['debuggers'] as
				| Array<Record<string, unknown>>
				| undefined;
			if (!debuggers) {
				continue;
			}
			for (const dbg of debuggers) {
				if (typeof dbg.type === 'string' && dbg.type.toLowerCase() === debugType) {
					const platformKey = platform.isMacintosh ? 'osx' : platform.isLinux ? 'linux' : 'windows';
					const platformSpec = (dbg[platformKey] ?? dbg) as Record<string, unknown>;
					const extPath = ext.extensionLocation.fsPath;

					if (platformSpec.runtime) {
						runtime = String(platformSpec.runtime);
					} else if (dbg.runtime) {
						runtime = String(dbg.runtime);
					}
					if (platformSpec.runtimeArgs) {
						runtimeArgs = platformSpec.runtimeArgs as string[];
					} else if (dbg.runtimeArgs) {
						runtimeArgs = dbg.runtimeArgs as string[];
					}
					if (platformSpec.program) {
						const p = String(platformSpec.program);
						program = p.startsWith('/') || p.startsWith('\\') ? p : `${extPath}/${p}`;
					} else if (dbg.program) {
						const p = String(dbg.program);
						program = p.startsWith('/') || p.startsWith('\\') ? p : `${extPath}/${p}`;
					}
					if (platformSpec.args) {
						cmdArgs = platformSpec.args as string[];
					} else if (dbg.args) {
						cmdArgs = dbg.args as string[];
					}
				}
			}
		}

		if (runtime) {
			return {
				type: 'executable',
				command: runtime,
				args: [...(runtimeArgs ?? []), ...(program ? [program] : []), ...(cmdArgs ?? [])]
			};
		} else if (program) {
			return {
				type: 'executable',
				command: program,
				args: cmdArgs ?? []
			};
		}

		return undefined;
	}

	protected override createSignService(): ISignService | undefined {
		return undefined;
	}

	public override async $runInTerminal(
		args: DebugProtocol.RunInTerminalRequestArguments,
		sessionId: string
	): Promise<number | undefined> {
		if (args.kind === 'integrated') {
			if (!this._terminalDisposedListener) {
				this._terminalDisposedListener = this._register(
					this._terminalService.onDidCloseTerminal(terminal => {
						this._integratedTerminalInstances.onTerminalClosed(terminal);
					})
				);
			}

			const configProvider = await this._configurationService.getConfigProvider();
			const shell = this._terminalService.getDefaultShell(true);
			const shellArgs = this._terminalService.getDefaultShellArgs(true);

			const terminalName = args.title || nls.localize('debug.terminal.title', 'Debug Process');

			const shellConfig = JSON.stringify({ shell, shellArgs });
			let terminal = await this._integratedTerminalInstances.checkout(shellConfig, terminalName);

			let cwdForPrepareCommand: string | undefined;
			let giveShellTimeToInitialize = false;

			if (!terminal) {
				const options: vscode.TerminalOptions = {
					shellPath: shell,
					shellArgs: shellArgs,
					cwd: args.cwd,
					name: terminalName,
					iconPath: new ThemeIcon('debug')
				};
				giveShellTimeToInitialize = true;
				terminal = this._terminalService.createTerminalFromOptions(options, {
					isFeatureTerminal: true,
					forceShellIntegration: true,
					useShellEnvironment: true
				});
				this._integratedTerminalInstances.insert(terminal, shellConfig);
			} else {
				cwdForPrepareCommand = args.cwd;
			}

			terminal.show(true);

			const shellProcessId = await terminal.processId;

			if (giveShellTimeToInitialize) {
				const ds = new DisposableStore();
				await new Promise<void>(resolve => {
					const scheduler = ds.add(new RunOnceScheduler(resolve, 500));
					ds.add(
						this._terminalService.onDidWriteTerminalData(e => {
							if (e.terminal === terminal) {
								scheduler.schedule();
							}
						})
					);
					ds.add(
						this._terminalShellIntegrationService.onDidChangeTerminalShellIntegration(e => {
							if (e.terminal === terminal) {
								resolve();
							}
						})
					);
					ds.add(disposableTimeout(resolve, 5000));
				});
				ds.dispose();
			} else {
				if (terminal.state.isInteractedWith && !terminal.shellIntegration) {
					terminal.sendText('\u0003');
					await timeout(200);
				}

				if (configProvider.getConfiguration('debug.terminal').get<boolean>('clearBeforeReusing')) {
					let clearCommand: string;
					if (platform.isWindows) {
						clearCommand = 'cls';
					} else {
						clearCommand = 'clear';
					}

					if (terminal.shellIntegration) {
						const ds = new DisposableStore();
						const execution = terminal.shellIntegration.executeCommand(clearCommand);
						await new Promise<void>(resolve => {
							ds.add(
								this._terminalShellIntegrationService.onDidEndTerminalShellExecution(e => {
									if (e.execution === execution) {
										resolve();
									}
								})
							);
							ds.add(disposableTimeout(resolve, 500));
						});
						ds.dispose();
					} else {
						terminal.sendText(clearCommand);
						await timeout(200);
					}
				}
			}

			// Build command from args — simplified terminal command preparation
			const command = this._prepareCommand(
				shell,
				args.args,
				!!args.argsCanBeInterpretedByShell,
				cwdForPrepareCommand,
				args.env
			);

			if (terminal.shellIntegration) {
				terminal.shellIntegration.executeCommand(command);
			} else {
				terminal.sendText(command);
			}

			const sessionListener = this.onDidTerminateDebugSession(s => {
				if (s.id === sessionId) {
					this._integratedTerminalInstances.free(terminal);
					sessionListener.dispose();
				}
			});

			return shellProcessId;
		}

		return super.$runInTerminal(args, sessionId);
	}

	private _prepareCommand(
		shell: string,
		args: string[],
		argsCanBeInterpretedByShell: boolean,
		cwd: string | undefined,
		env: { [key: string]: string | null } | undefined
	): string {
		const parts: string[] = [];

		if (cwd) {
			parts.push(`cd ${this._quote(shell, cwd)} &&`);
		}

		if (env) {
			for (const [k, v] of Object.entries(env)) {
				if (v !== null) {
					if (platform.isWindows) {
						parts.push(`set "${k}=${v}" &&`);
					} else {
						parts.push(`${k}=${this._quote(shell, v)}`);
					}
				}
			}
		}

		if (argsCanBeInterpretedByShell) {
			parts.push(args.join(' '));
		} else {
			parts.push(...args.map(a => this._quote(shell, a)));
		}

		return parts.join(' ');
	}

	private _quote(shell: string, s: string): string {
		if (!s.includes(' ') && !s.includes('"') && !s.includes("'")) {
			return s;
		}
		const basename = shell.split('/').pop()?.split('\\').pop()?.toLowerCase() ?? '';
		if (basename === 'cmd.exe' || basename === 'cmd') {
			return `"${s}"`;
		}
		return `'${s.replace(/'/g, "'\\''")}'`;
	}
}

class DebugTerminalCollection {
	private static minUseDelay = 1000;
	private _terminalInstances = new Map<vscode.Terminal, { lastUsedAt: number; config: string }>();

	public async checkout(config: string, name: string, cleanupOthersByName = false) {
		const entries = [...this._terminalInstances.entries()];
		const promises = entries.map(([terminal, termInfo]) =>
			createCancelablePromise(async ct => {
				if (terminal.name !== name) {
					return null;
				}
				const now = Date.now();
				if (termInfo.lastUsedAt + DebugTerminalCollection.minUseDelay > now || ct.isCancellationRequested) {
					return null;
				}
				if (termInfo.config !== config) {
					if (cleanupOthersByName) {
						terminal.dispose();
					}
					return null;
				}
				termInfo.lastUsedAt = now;
				return terminal;
			})
		);
		return await firstParallel(promises, (t): t is vscode.Terminal => !!t);
	}

	public insert(terminal: vscode.Terminal, termConfig: string) {
		this._terminalInstances.set(terminal, { lastUsedAt: Date.now(), config: termConfig });
	}

	public free(terminal: vscode.Terminal) {
		const info = this._terminalInstances.get(terminal);
		if (info) {
			info.lastUsedAt = -1;
		}
	}

	public onTerminalClosed(terminal: vscode.Terminal) {
		this._terminalInstances.delete(terminal);
	}
}
