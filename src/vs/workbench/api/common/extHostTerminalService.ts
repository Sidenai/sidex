/*---------------------------------------------------------------------------------------------
 *  SideX — ExtHost terminal service stub. Terminal operations are handled by the Tauri
 *  backend's terminal subsystem; extension-level terminal APIs accept registrations but
 *  return inert objects.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { Event, Emitter } from '../../../base/common/event.js';
import {
	ExtHostTerminalServiceShape,
	ITerminalDimensionsDto,
	ITerminalLinkDto,
	ExtHostTerminalIdentifier,
	ITerminalCommandDto,
	ITerminalCompletionContextDto,
	TerminalCompletionListDto,
	TerminalCommandMatchResultDto,
	ITerminalQuickFixOpenerDto,
	ITerminalQuickFixTerminalCommandDto
} from './extHost.protocol.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../base/common/uri.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import {
	ICreateContributedTerminalProfileOptions,
	ITerminalLaunchError,
	ITerminalProfile,
	TerminalLocation,
	TerminalShellType
} from '../../../platform/terminal/common/terminal.js';
import { ISerializableEnvironmentVariableCollection } from '../../../platform/terminal/common/environmentVariable.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { SingleOrMany } from '../../../base/common/types.js';

export interface ITerminalInternalOptions {
	cwd?: string | URI;
	isFeatureTerminal?: boolean;
	forceShellIntegration?: boolean;
	useShellEnvironment?: boolean;
	resolvedExtHostIdentifier?: ExtHostTerminalIdentifier;
	location?: TerminalLocation | { viewColumn: number; preserveState?: boolean } | { splitActiveTerminal: boolean };
}

export interface IExtHostTerminalService extends ExtHostTerminalServiceShape, IDisposable {
	readonly _serviceBrand: undefined;

	activeTerminal: vscode.Terminal | undefined;
	terminals: vscode.Terminal[];

	readonly onDidCloseTerminal: Event<vscode.Terminal>;
	readonly onDidOpenTerminal: Event<vscode.Terminal>;
	readonly onDidChangeActiveTerminal: Event<vscode.Terminal | undefined>;
	readonly onDidChangeTerminalDimensions: Event<vscode.TerminalDimensionsChangeEvent>;
	readonly onDidChangeTerminalState: Event<vscode.Terminal>;
	readonly onDidWriteTerminalData: Event<vscode.TerminalDataWriteEvent>;
	readonly onDidExecuteTerminalCommand: Event<vscode.TerminalExecutedCommand>;
	readonly onDidChangeShell: Event<string>;

	createTerminal(name?: string, shellPath?: string, shellArgs?: readonly string[] | string): vscode.Terminal;
	createTerminalFromOptions(
		options: vscode.TerminalOptions,
		internalOptions?: ITerminalInternalOptions
	): vscode.Terminal;
	createExtensionTerminal(options: vscode.ExtensionTerminalOptions): vscode.Terminal;
	attachPtyToTerminal(id: number, pty: vscode.Pseudoterminal): void;
	getDefaultShell(useAutomationShell: boolean): string;
	getDefaultShellArgs(useAutomationShell: boolean): string[] | string;
	registerLinkProvider(provider: vscode.TerminalLinkProvider): vscode.Disposable;
	registerProfileProvider(
		extension: IExtensionDescription,
		id: string,
		provider: vscode.TerminalProfileProvider
	): vscode.Disposable;
	registerTerminalQuickFixProvider(
		id: string,
		extensionId: string,
		provider: vscode.TerminalQuickFixProvider
	): vscode.Disposable;
	getEnvironmentVariableCollection(
		extension: IExtensionDescription
	): vscode.EnvironmentVariableCollection & {
		getScoped(scope: vscode.EnvironmentVariableScope): vscode.EnvironmentVariableCollection;
	};
	getTerminalById(id: number): ExtHostTerminal | null;
	getTerminalIdByApiObject(apiTerminal: vscode.Terminal): number | null;
	registerTerminalCompletionProvider(
		extension: IExtensionDescription,
		provider: vscode.TerminalCompletionProvider<vscode.TerminalCompletionItem>,
		...triggerCharacters: string[]
	): vscode.Disposable;
}

export const IExtHostTerminalService = createDecorator<IExtHostTerminalService>('IExtHostTerminalService');

export class ExtHostTerminal extends Disposable {
	public isOpen = false;
	shellIntegration: vscode.TerminalShellIntegration | undefined;
	readonly value: vscode.Terminal;

	private readonly _onWillDispose = this._register(new Emitter<void>());
	readonly onWillDispose = this._onWillDispose.event;

	constructor(
		public _id: ExtHostTerminalIdentifier,
		name?: string
	) {
		super();
		const noop = () => undefined;
		this.value = {
			name: name ?? '',
			processId: Promise.resolve(undefined),
			creationOptions: Object.freeze({}) as vscode.TerminalOptions,
			exitStatus: undefined,
			state: { isInteractedWith: false, shell: undefined },
			shellIntegration: undefined,
			sendText: noop,
			show: noop,
			hide: noop,
			dispose: () => this.dispose()
		} as vscode.Terminal;
	}
}

class StubEnvVarCollection implements vscode.EnvironmentVariableCollection {
	persistent = true;
	description: string | vscode.MarkdownString | undefined = undefined;
	replace() {}
	append() {}
	prepend() {}
	get() {
		return undefined;
	}
	forEach() {}
	delete() {}
	clear() {}
	*[Symbol.iterator](): IterableIterator<[variable: string, mutator: vscode.EnvironmentVariableMutator]> {}
	getScoped(_scope: vscode.EnvironmentVariableScope): vscode.EnvironmentVariableCollection {
		return this;
	}
}

export abstract class BaseExtHostTerminalService extends Disposable implements IExtHostTerminalService {
	readonly _serviceBrand: undefined;

	activeTerminal: vscode.Terminal | undefined = undefined;
	terminals: vscode.Terminal[] = [];

	protected readonly _onDidCloseTerminal = this._register(new Emitter<vscode.Terminal>());
	readonly onDidCloseTerminal = this._onDidCloseTerminal.event;
	protected readonly _onDidOpenTerminal = this._register(new Emitter<vscode.Terminal>());
	readonly onDidOpenTerminal = this._onDidOpenTerminal.event;
	protected readonly _onDidChangeActiveTerminal = this._register(new Emitter<vscode.Terminal | undefined>());
	readonly onDidChangeActiveTerminal = this._onDidChangeActiveTerminal.event;
	protected readonly _onDidChangeTerminalDimensions = this._register(
		new Emitter<vscode.TerminalDimensionsChangeEvent>()
	);
	readonly onDidChangeTerminalDimensions = this._onDidChangeTerminalDimensions.event;
	protected readonly _onDidChangeTerminalState = this._register(new Emitter<vscode.Terminal>());
	readonly onDidChangeTerminalState = this._onDidChangeTerminalState.event;
	protected readonly _onDidWriteTerminalData = this._register(new Emitter<vscode.TerminalDataWriteEvent>());
	readonly onDidWriteTerminalData = this._onDidWriteTerminalData.event;
	protected readonly _onDidExecuteTerminalCommand = this._register(new Emitter<vscode.TerminalExecutedCommand>());
	readonly onDidExecuteTerminalCommand = this._onDidExecuteTerminalCommand.event;
	protected readonly _onDidChangeShell = this._register(new Emitter<string>());
	readonly onDidChangeShell = this._onDidChangeShell.event;

	private readonly _envVarCollection = new StubEnvVarCollection();

	createTerminal(name?: string): vscode.Terminal {
		return new ExtHostTerminal(0, name).value;
	}
	createTerminalFromOptions(options: vscode.TerminalOptions): vscode.Terminal {
		return new ExtHostTerminal(0, options.name).value;
	}
	createExtensionTerminal(options: vscode.ExtensionTerminalOptions): vscode.Terminal {
		return new ExtHostTerminal(0, options.name).value;
	}
	attachPtyToTerminal(): void {}
	getDefaultShell(): string {
		return '';
	}
	getDefaultShellArgs(): string[] {
		return [];
	}
	registerLinkProvider(): vscode.Disposable {
		return toDisposable(() => {});
	}
	registerProfileProvider(): vscode.Disposable {
		return toDisposable(() => {});
	}
	registerTerminalQuickFixProvider(): vscode.Disposable {
		return toDisposable(() => {});
	}
	getEnvironmentVariableCollection() {
		return this._envVarCollection;
	}
	getTerminalById(): ExtHostTerminal | null {
		return null;
	}
	getTerminalIdByApiObject(): number | null {
		return null;
	}
	registerTerminalCompletionProvider(): vscode.Disposable {
		return toDisposable(() => {});
	}

	// Shape methods — all no-ops.
	$acceptTerminalClosed(): void {}
	$acceptTerminalOpened(): void {}
	$acceptActiveTerminalChanged(): void {}
	$acceptTerminalProcessId(): void {}
	$acceptTerminalProcessData(): void {}
	$acceptDidExecuteCommand(_id: number, _command: ITerminalCommandDto): void {}
	$acceptTerminalTitleChange(): void {}
	$acceptTerminalDimensions(): void {}
	$acceptTerminalMaximumDimensions(): void {}
	$acceptTerminalInteraction(): void {}
	$acceptTerminalSelection(): void {}
	$acceptTerminalShellType(_id: number, _shellType: TerminalShellType | undefined): void {}
	async $startExtensionTerminal(
		_id: number,
		_initialDimensions: ITerminalDimensionsDto | undefined
	): Promise<ITerminalLaunchError | undefined> {
		return undefined;
	}
	$acceptProcessAckDataEvent(): void {}
	$acceptProcessInput(): void {}
	$acceptProcessResize(): void {}
	$acceptProcessShutdown(): void {}
	$acceptProcessRequestInitialCwd(): void {}
	$acceptProcessRequestCwd(): void {}
	async $acceptProcessRequestLatency(): Promise<number> {
		return 0;
	}
	async $provideLinks(_id: number, _line: string): Promise<ITerminalLinkDto[]> {
		return [];
	}
	$activateLink(): void {}
	$initEnvironmentVariableCollections(_collections: [string, ISerializableEnvironmentVariableCollection][]): void {}
	$acceptDefaultProfile(_profile: ITerminalProfile, _automationProfile: ITerminalProfile): void {}
	async $createContributedProfileTerminal(
		_id: string,
		_options: ICreateContributedTerminalProfileOptions
	): Promise<void> {}
	async $provideTerminalQuickFixes(
		_id: string,
		_matchResult: TerminalCommandMatchResultDto,
		_token: CancellationToken
	): Promise<SingleOrMany<ITerminalQuickFixOpenerDto | ITerminalQuickFixTerminalCommandDto> | undefined> {
		return undefined;
	}
	async $provideTerminalCompletions(
		_id: string,
		_options: ITerminalCompletionContextDto,
		_token: CancellationToken
	): Promise<TerminalCompletionListDto | undefined> {
		return undefined;
	}
}

export class WorkerExtHostTerminalService extends BaseExtHostTerminalService {}
