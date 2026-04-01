/*---------------------------------------------------------------------------------------------
 *  Tauri Git SCM Provider for SideX
 *  Registers a native Git source control provider using Tauri's invoke() API
 *  instead of the VS Code extension host protocol.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { observableValue } from '../../../../base/common/observable.js';
import type { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ResourceTree } from '../../../../base/common/resourceTree.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { basename } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { ISCMService, ISCMProvider, ISCMResource, ISCMResourceGroup, ISCMResourceDecorations, ISCMActionButtonDescriptor } from '../common/scm.js';
import type { ISCMHistoryProvider } from '../common/history.js';
import type { ISCMArtifactProvider } from '../common/artifact.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import type { Command } from '../../../../editor/common/languages.js';
import type { Event } from '../../../../base/common/event.js';

// ─── Tauri invoke() bridge ──────────────────────────────────────────────────

interface TauriGitChange {
	path: string;
	status: string;
	staged: boolean;
}

interface TauriGitStatus {
	branch: string;
	changes: TauriGitChange[];
}

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;

async function getTauriInvoke(): Promise<typeof _invoke> {
	if (_invoke) {
		return _invoke;
	}
	try {
		const mod = await import('@tauri-apps/api/core');
		_invoke = mod.invoke;
		return _invoke;
	} catch {
		return undefined;
	}
}

async function invokeGit<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
	const invoke = await getTauriInvoke();
	if (!invoke) {
		return undefined;
	}
	return invoke(cmd, args) as Promise<T>;
}

// ─── SCM Resource ───────────────────────────────────────────────────────────

class TauriGitResource implements ISCMResource {

	readonly decorations: ISCMResourceDecorations;
	readonly contextValue: string | undefined;
	readonly command: Command | undefined;
	readonly multiDiffEditorOriginalUri: URI | undefined;
	readonly multiDiffEditorModifiedUri: URI | undefined;

	constructor(
		readonly resourceGroup: ISCMResourceGroup,
		readonly sourceUri: URI,
		private readonly _status: string,
		private readonly _staged: boolean,
	) {
		this.decorations = TauriGitResource._decorationForStatus(_status);
		this.contextValue = _staged ? 'staged' : 'unstaged';
		this.command = undefined;
		this.multiDiffEditorOriginalUri = undefined;
		this.multiDiffEditorModifiedUri = undefined;
	}

	async open(_preserveFocus: boolean): Promise<void> {
		// TODO: open diff editor via Tauri git_diff
	}

	private static _decorationForStatus(status: string): ISCMResourceDecorations {
		switch (status) {
			case 'modified':
				return { tooltip: 'Modified', icon: ThemeIcon.fromId('diff-modified') };
			case 'added':
			case 'new file':
				return { tooltip: 'Added', icon: ThemeIcon.fromId('diff-added') };
			case 'deleted':
				return { tooltip: 'Deleted', icon: ThemeIcon.fromId('diff-removed'), strikeThrough: true };
			case 'renamed':
				return { tooltip: 'Renamed', icon: ThemeIcon.fromId('diff-renamed') };
			case 'untracked':
				return { tooltip: 'Untracked', icon: ThemeIcon.fromId('question'), faded: true };
			default:
				return { tooltip: status };
		}
	}
}

// ─── SCM Resource Group ─────────────────────────────────────────────────────

class TauriGitResourceGroup implements ISCMResourceGroup {

	resources: ISCMResource[] = [];

	private _resourceTree: ResourceTree<ISCMResource, ISCMResourceGroup> | undefined;
	get resourceTree(): ResourceTree<ISCMResource, ISCMResourceGroup> {
		if (!this._resourceTree) {
			const rootUri = this.provider.rootUri ?? URI.file('/');
			this._resourceTree = new ResourceTree<ISCMResource, ISCMResourceGroup>(this, rootUri, this._uriIdentService.extUri);
			for (const resource of this.resources) {
				this._resourceTree.add(resource.sourceUri, resource);
			}
		}
		return this._resourceTree;
	}

	readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	readonly _onDidChangeResources = new Emitter<void>();
	readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;

	readonly hideWhenEmpty = true;
	contextValue: string | undefined;
	readonly multiDiffEditorEnableViewChanges = false;

	constructor(
		readonly id: string,
		readonly label: string,
		readonly provider: ISCMProvider,
		private readonly _uriIdentService: IUriIdentityService,
	) {
		this.contextValue = id;
	}

	setResources(resources: ISCMResource[]): void {
		this.resources = resources;
		this._resourceTree = undefined;
		this._onDidChangeResources.fire();
		this._onDidChange.fire();
	}
}

// ─── SCM Provider ───────────────────────────────────────────────────────────

class TauriGitSCMProvider extends Disposable implements ISCMProvider {

	readonly id: string;
	readonly providerId = 'tauri-git';
	readonly label = 'Git';
	readonly name: string;
	readonly rootUri: URI;
	readonly iconPath = ThemeIcon.fromId('source-control');
	readonly isHidden = false;
	readonly inputBoxTextModel: ITextModel;

	private readonly _contextValue = observableValue<string | undefined>(this, 'tauri-git');
	get contextValue(): IObservable<string | undefined> { return this._contextValue; }

	private readonly _count = observableValue<number | undefined>(this, undefined);
	get count(): IObservable<number | undefined> { return this._count; }

	private readonly _commitTemplate = observableValue<string>(this, '');
	get commitTemplate(): IObservable<string> { return this._commitTemplate; }

	private readonly _actionButton = observableValue<ISCMActionButtonDescriptor | undefined>(this, undefined);
	get actionButton(): IObservable<ISCMActionButtonDescriptor | undefined> { return this._actionButton; }

	private readonly _statusBarCommands = observableValue<readonly Command[] | undefined>(this, undefined);
	get statusBarCommands(): IObservable<readonly Command[] | undefined> { return this._statusBarCommands; }

	private readonly _artifactProvider = observableValue<ISCMArtifactProvider | undefined>(this, undefined);
	get artifactProvider(): IObservable<ISCMArtifactProvider | undefined> { return this._artifactProvider; }

	private readonly _historyProvider = observableValue<ISCMHistoryProvider | undefined>(this, undefined);
	get historyProvider(): IObservable<ISCMHistoryProvider | undefined> { return this._historyProvider; }

	readonly acceptInputCommand: Command = {
		id: 'tauri-git.commit',
		title: 'Commit',
	};

	private readonly _stagedGroup: TauriGitResourceGroup;
	private readonly _changesGroup: TauriGitResourceGroup;
	readonly groups: TauriGitResourceGroup[];

	private readonly _onDidChangeResourceGroups = new Emitter<void>();
	readonly onDidChangeResourceGroups: Event<void> = this._onDidChangeResourceGroups.event;

	private readonly _onDidChangeResources = new Emitter<void>();
	readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;

	private _branch = '';

	constructor(
		rootUri: URI,
		modelService: IModelService,
		languageService: ILanguageService,
		private readonly uriIdentityService: IUriIdentityService,
		private readonly logService: ILogService,
	) {
		super();

		this.rootUri = rootUri;
		this.id = `tauri-git:${rootUri.toString()}`;
		this.name = basename(rootUri) || 'Git';

		const inputUri = URI.from({ scheme: Schemas.vscodeSourceControl, path: `/${this.id}/input` });
		let model = modelService.getModel(inputUri);
		if (!model) {
			model = modelService.createModel('', languageService.createById('scminput'), inputUri);
		}
		this.inputBoxTextModel = model;

		this._stagedGroup = new TauriGitResourceGroup('staged', 'Staged Changes', this, uriIdentityService);
		this._changesGroup = new TauriGitResourceGroup('changes', 'Changes', this, uriIdentityService);
		this.groups = [this._stagedGroup, this._changesGroup];

		this._register(this._onDidChangeResourceGroups);
		this._register(this._onDidChangeResources);
		this._register(this._stagedGroup._onDidChange);
		this._register(this._stagedGroup._onDidChangeResources);
		this._register(this._changesGroup._onDidChange);
		this._register(this._changesGroup._onDidChangeResources);
	}

	async getOriginalResource(_uri: URI): Promise<URI | null> {
		return null;
	}

	async refresh(): Promise<void> {
		const rootPath = this.rootUri.fsPath;
		let status: TauriGitStatus | undefined;
		try {
			status = await invokeGit<TauriGitStatus>('git_status', { path: rootPath });
			console.log('[TauriGit] git_status result:', status);
		} catch (err) {
			console.error('[TauriGit] git_status failed:', err);
			this.logService.warn('[TauriGit] git_status failed', err);
			return;
		}

		if (!status) {
			console.log('[TauriGit] No status returned');
			return;
		}

		this._branch = status.branch;
		console.log('[TauriGit] Branch:', this._branch, 'Changes:', status.changes.length);

		const stagedResources: ISCMResource[] = [];
		const changesResources: ISCMResource[] = [];

		for (const change of status.changes) {
			const fileUri = URI.joinPath(this.rootUri, change.path);
			if (change.staged) {
				stagedResources.push(new TauriGitResource(this._stagedGroup, fileUri, change.status, true));
			} else {
				changesResources.push(new TauriGitResource(this._changesGroup, fileUri, change.status, false));
			}
		}

		this._stagedGroup.setResources(stagedResources);
		this._changesGroup.setResources(changesResources);

		// Fire provider-level change events so the SCM view updates
		this._onDidChangeResources.fire();
		this._onDidChangeResourceGroups.fire();

		const total = stagedResources.length + changesResources.length;
		this._count.set(total, undefined);

		this._statusBarCommands.set([{
			id: 'tauri-git.noop',
			title: `$(git-branch) ${this._branch}`,
			tooltip: `Branch: ${this._branch}`,
		}], undefined);

		this._actionButton.set(stagedResources.length > 0 ? {
			command: { id: 'tauri-git.commit', title: '$(check) Commit' },
			enabled: true,
		} : undefined, undefined);

		this._onDidChangeResources.fire();
	}
}

// ─── Workbench Contribution ─────────────────────────────────────────────────

class TauriGitContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.tauriGit';

	private _pollHandle: ReturnType<typeof setInterval> | undefined;

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._init();
	}

	private async _init(): Promise<void> {
		console.log('[TauriGit] _init started');
		const folders = this.workspaceContextService.getWorkspace().folders;
		console.log('[TauriGit] Workspace folders:', folders.length, folders.map(f => f.uri.toString()));

		// Store folders globally for git.init command
		(window as any).__sidex_workspaceFolders = folders.map(f => f.uri.fsPath);

		if (folders.length === 0) {
			console.log('[TauriGit] No workspace folders, skipping');
			return;
		}

		const rootUri = folders[0].uri;
		const rootPath = rootUri.fsPath;
		console.log('[TauriGit] Checking if git repo:', rootPath);

		let isRepo: boolean | undefined;
		try {
			isRepo = await invokeGit<boolean>('git_is_repo', { path: rootPath });
			console.log('[TauriGit] git_is_repo result:', isRepo);
		} catch (err) {
			console.error('[TauriGit] git_is_repo failed:', err);
			this.logService.info('[TauriGit] git_is_repo unavailable — Tauri backend not present', err);
			return;
		}

		if (!isRepo) {
			console.log('[TauriGit] Not a git repo, skipping');
			return;
		}

		console.log('[TauriGit] Git repository detected, registering SCM provider');

		const provider = new TauriGitSCMProvider(
			rootUri,
			this.modelService,
			this.languageService,
			this.uriIdentityService,
			this.logService,
		);

		const repository = this.scmService.registerSCMProvider(provider);
		this._register(repository);
		this._register(provider);

		this._registerCommitCommand(provider, rootPath);

		await provider.refresh();

		this._pollHandle = setInterval(() => provider.refresh(), 3000);
		this._register({
			dispose: () => {
				if (this._pollHandle !== undefined) {
					clearInterval(this._pollHandle);
					this._pollHandle = undefined;
				}
			}
		});
	}

	private _registerCommitCommand(provider: TauriGitSCMProvider, rootPath: string): void {
		this._register(CommandsRegistry.registerCommand('tauri-git.commit', async () => {
			const message = provider.inputBoxTextModel.getValue();
			if (!message.trim()) {
				return;
			}
			try {
				const hash = await invokeGit<string>('git_commit', { path: rootPath, message });
				this.logService.info(`[TauriGit] Committed: ${hash}`);
				provider.inputBoxTextModel.setValue('');
				await provider.refresh();
			} catch (err) {
				this.logService.error('[TauriGit] commit failed', err);
			}
		}));
	}
}

// Register git.init command globally so the "Initialize Repository" button works
CommandsRegistry.registerCommand('git.init', async () => {
	try {
		const invoke = await getTauriInvoke();
		if (!invoke) { return; }

		const { open } = await import('@tauri-apps/plugin-dialog');
		// Use the current workspace folder if available, otherwise ask
		const folders = (window as any).__sidex_workspaceFolders;
		let targetPath: string | undefined;

		if (folders && folders.length > 0) {
			targetPath = folders[0];
		} else {
			const selected = await open({ directory: true, title: 'Initialize Git Repository' });
			if (selected && typeof selected === 'string') {
				targetPath = selected;
			}
		}

		if (!targetPath) { return; }

		await invoke('git_init', { path: targetPath });
		console.log('[TauriGit] Repository initialized at', targetPath);

		// Reload to pick up the new git repo
		window.location.reload();
	} catch (err) {
		console.error('[TauriGit] git init failed:', err);
	}
});

registerWorkbenchContribution2(
	TauriGitContribution.ID,
	TauriGitContribution,
	WorkbenchPhase.AfterRestored,
);
