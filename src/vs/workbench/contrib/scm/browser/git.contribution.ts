/*---------------------------------------------------------------------------------------------
 *  Tauri Git SCM Provider for SideX
 *  Registers a native Git source control provider using Tauri's invoke() API
 *  instead of the VS Code extension host protocol.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { observableValue } from '../../../../base/common/observable.js';
import type { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ResourceTree } from '../../../../base/common/resourceTree.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import {
	ISCMService,
	ISCMProvider,
	ISCMResource,
	ISCMResourceGroup,
	ISCMResourceDecorations,
	ISCMActionButtonDescriptor
} from '../common/scm.js';
import type {
	ISCMHistoryProvider,
	ISCMHistoryOptions,
	ISCMHistoryItem,
	ISCMHistoryItemChange,
	ISCMHistoryItemRef,
	ISCMHistoryItemRefsChangeEvent
} from '../common/history.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { ISCMArtifactProvider } from '../common/artifact.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { FileSystemProviderCapabilities, FileType, FilePermission } from '../../../../platform/files/common/files.js';
import type {
	IFileSystemProvider,
	IStat,
	IFileDeleteOptions,
	IFileOverwriteOptions,
	IFileWriteOptions,
	IWatchOptions,
	IFileChange
} from '../../../../platform/files/common/files.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import type { Command } from '../../../../editor/common/languages.js';
import type { Event } from '../../../../base/common/event.js';
import {
	IDecorationsService,
	IDecorationsProvider,
	IDecorationData
} from '../../../services/decorations/common/decorations.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { historyItemRefColor, historyItemRemoteRefColor } from './scmHistory.js';

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

interface TauriGitLogEntry {
	hash: string;
	message: string;
	author: string;
	email?: string;
	date: string;
	parent_hashes?: string[];
	files_changed?: number;
	insertions?: number;
	deletions?: number;
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

// ─── Git Original File System Provider ──────────────────────────────────────

const GIT_ORIGINAL_SCHEME = 'git-original';

class TauriGitOriginalFileProvider implements IFileSystemProvider {
	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.Readonly;

	private readonly _onDidChangeCapabilities = new Emitter<void>();
	readonly onDidChangeCapabilities: Event<void> = this._onDidChangeCapabilities.event;

	private readonly _onDidChangeFile = new Emitter<readonly IFileChange[]>();
	readonly onDidChangeFile: Event<readonly IFileChange[]> = this._onDidChangeFile.event;

	constructor(private readonly _workspaceRoot: string) {}

	watch(_resource: URI, _opts: IWatchOptions): IDisposable {
		return Disposable.None;
	}

	async stat(_resource: URI): Promise<IStat> {
		return { type: FileType.File, ctime: 0, mtime: 0, size: 0, permissions: FilePermission.Readonly };
	}

	async mkdir(_resource: URI): Promise<void> {
		throw new Error('git-original is read-only');
	}

	async readdir(_resource: URI): Promise<[string, FileType][]> {
		return [];
	}

	async delete(_resource: URI, _opts: IFileDeleteOptions): Promise<void> {
		throw new Error('git-original is read-only');
	}

	async rename(_from: URI, _to: URI, _opts: IFileOverwriteOptions): Promise<void> {
		throw new Error('git-original is read-only');
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const filePath = resource.path.startsWith('/') ? resource.path.slice(1) : resource.path;
		const gitRef = resource.query || 'HEAD';
		const invoke = await getTauriInvoke();
		if (!invoke) {
			return new Uint8Array();
		}
		try {
			const revFile = `${gitRef}:${filePath}`;
			const output = (await invoke('git_run', {
				path: this._workspaceRoot,
				args: ['show', revFile]
			})) as string;
			return new TextEncoder().encode(output);
		} catch {
			try {
				const bytes = (await invoke('git_show', { path: this._workspaceRoot, file: filePath })) as number[];
				return new Uint8Array(bytes);
			} catch {
				return new Uint8Array();
			}
		}
	}

	async writeFile(_resource: URI, _content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
		throw new Error('git-original is read-only');
	}
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
		private readonly _workspaceRootUri: URI
	) {
		this.decorations = TauriGitResource._decorationForStatus(_status);
		this.contextValue = _staged ? 'staged' : 'unstaged';

		const relPath = relativePath(_workspaceRootUri, sourceUri) ?? sourceUri.path;

		if (_status === 'untracked' || _status === 'added') {
			this.command = { id: 'git.openFile', title: 'Open File' };
			this.multiDiffEditorOriginalUri = undefined;
			this.multiDiffEditorModifiedUri = sourceUri;
		} else if (_status === 'deleted') {
			const originalUri = URI.from({ scheme: GIT_ORIGINAL_SCHEME, path: `/${relPath}` });
			this.command = { id: 'git.openDiff', title: 'Open Changes' };
			this.multiDiffEditorOriginalUri = originalUri;
			this.multiDiffEditorModifiedUri = undefined;
		} else {
			const originalUri = URI.from({ scheme: GIT_ORIGINAL_SCHEME, path: `/${relPath}` });
			this.command = { id: 'git.openDiff', title: 'Open Changes' };
			this.multiDiffEditorOriginalUri = originalUri;
			this.multiDiffEditorModifiedUri = sourceUri;
		}
	}

	get statusLabel(): string {
		return this._status;
	}

	async open(_preserveFocus: boolean): Promise<void> {
		const commandService = (globalThis as any).__sidex_commandService;
		if (!commandService) {
			return;
		}
		if (this.command?.id === 'git.openDiff') {
			await commandService.executeCommand('git.openDiff', this);
		} else {
			await commandService.executeCommand('git.openFile', this);
		}
	}

	private static _decorationForStatus(status: string): ISCMResourceDecorations {
		switch (status) {
			case 'modified':
				return { tooltip: 'Modified', icon: ThemeIcon.fromId('diff-modified'), faded: false };
			case 'added':
			case 'new file':
				return { tooltip: 'Added', icon: ThemeIcon.fromId('diff-added'), faded: false };
			case 'deleted':
				return { tooltip: 'Deleted', icon: ThemeIcon.fromId('diff-removed'), strikeThrough: true, faded: false };
			case 'renamed':
				return { tooltip: 'Renamed', icon: ThemeIcon.fromId('diff-renamed'), faded: false };
			case 'untracked':
				return { tooltip: 'Untracked', icon: ThemeIcon.fromId('diff-added'), faded: false };
			default:
				return { tooltip: status, faded: false };
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
			this._resourceTree = new ResourceTree<ISCMResource, ISCMResourceGroup>(
				this,
				rootUri,
				this._uriIdentService.extUri
			);
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

	readonly hideWhenEmpty: boolean;
	contextValue: string | undefined;
	readonly multiDiffEditorEnableViewChanges = false;

	constructor(
		readonly id: string,
		readonly label: string,
		readonly provider: ISCMProvider,
		private readonly _uriIdentService: IUriIdentityService,
		hideWhenEmpty: boolean = false
	) {
		this.contextValue = id;
		this.hideWhenEmpty = hideWhenEmpty;
	}

	setResources(resources: ISCMResource[]): void {
		this.resources = resources;
		this._resourceTree = undefined;
		this._onDidChangeResources.fire();
		this._onDidChange.fire();
	}
}

// ─── SCM History Provider ───────────────────────────────────────────────────

class TauriGitHistoryProvider implements ISCMHistoryProvider {
	private readonly _historyItemRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	readonly historyItemRef: IObservable<ISCMHistoryItemRef | undefined> = this._historyItemRef;

	private readonly _historyItemRemoteRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	readonly historyItemRemoteRef: IObservable<ISCMHistoryItemRef | undefined> = this._historyItemRemoteRef;

	private readonly _historyItemBaseRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	readonly historyItemBaseRef: IObservable<ISCMHistoryItemRef | undefined> = this._historyItemBaseRef;

	private readonly _historyItemRefChanges = observableValue<ISCMHistoryItemRefsChangeEvent>(this, {
		added: [],
		removed: [],
		modified: [],
		silent: true
	});
	readonly historyItemRefChanges: IObservable<ISCMHistoryItemRefsChangeEvent> = this._historyItemRefChanges;

	constructor(
		private readonly _rootPath: string,
		private readonly _rootUri: URI,
		private readonly _logService: ILogService
	) {}

	_githubUrl: string | undefined;

	async _detectGitHubUrl(): Promise<string | undefined> {
		try {
			const invoke = await getTauriInvoke();
			if (!invoke) {
				return undefined;
			}
			const output = (await invoke('git_run', {
				path: this._rootPath,
				args: ['remote', 'get-url', 'origin']
			})) as string;
			const url = output.trim();
			this._githubUrl = url;
			return url;
		} catch {
			return undefined;
		}
	}

	updateRef(branch: string, headHash?: string): void {
		const newRef: ISCMHistoryItemRef = {
			id: `refs/heads/${branch}`,
			name: branch,
			revision: headHash,
			color: historyItemRefColor,
			icon: ThemeIcon.fromId('git-branch')
		};

		const oldRef = this._historyItemRef.get();
		this._historyItemRef.set(newRef, undefined);

		this._resolveRemoteRef(branch, headHash);

		if (oldRef?.revision !== headHash) {
			this._historyItemRefChanges.set(
				{
					added: oldRef ? [] : [newRef],
					removed: [],
					modified: oldRef ? [newRef] : [],
					silent: false
				},
				undefined
			);
		}
	}

	private async _resolveRemoteRef(branch: string, _headHash?: string): Promise<void> {
		try {
			const invoke = await getTauriInvoke();
			if (!invoke) {
				return;
			}

			const trackingBranch = (
				(await invoke('git_run', {
					path: this._rootPath,
					args: ['config', '--get', `branch.${branch}.remote`]
				})) as string
			).trim();

			if (trackingBranch) {
				const remoteBranch = (
					(await invoke('git_run', {
						path: this._rootPath,
						args: ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]
					})) as string
				).trim();

				const remoteHash = (
					(await invoke('git_run', {
						path: this._rootPath,
						args: ['rev-parse', remoteBranch]
					})) as string
				).trim();

				this._historyItemRemoteRef.set(
					{
						id: `refs/remotes/${remoteBranch}`,
						name: remoteBranch,
						revision: remoteHash,
						color: historyItemRemoteRefColor,
						icon: ThemeIcon.fromId('cloud')
					},
					undefined
				);

				this._historyItemBaseRef.set(
					{
						id: `refs/remotes/${remoteBranch}`,
						name: remoteBranch,
						revision: remoteHash,
						icon: ThemeIcon.fromId('git-commit')
					},
					undefined
				);
			}
		} catch {
			// No upstream configured
		}
	}

	async provideHistoryItemRefs(
		_historyItemRefs?: string[],
		_token?: CancellationToken
	): Promise<ISCMHistoryItemRef[] | undefined> {
		const refs: ISCMHistoryItemRef[] = [];
		const current = this._historyItemRef.get();
		if (current) {
			refs.push(current);
		}
		const remote = this._historyItemRemoteRef.get();
		if (remote) {
			refs.push(remote);
		}
		return refs;
	}

	async provideHistoryItems(
		options: ISCMHistoryOptions,
		_token?: CancellationToken
	): Promise<ISCMHistoryItem[] | undefined> {
		try {
			const limit = typeof options.limit === 'number' ? options.limit : 50;
			const entries = await invokeGit<TauriGitLogEntry[]>('git_log_graph', {
				path: this._rootPath,
				limit: limit + (options.skip ?? 0)
			});

			if (!entries) {
				return [];
			}

			const skip = options.skip ?? 0;
			const sliced = skip > 0 ? entries.slice(skip) : entries;

			const currentRef = this._historyItemRef.get();
			const remoteRef = this._historyItemRemoteRef.get();

			return sliced.map((entry, index) => {
				const references: ISCMHistoryItemRef[] = [];
				if (index === 0 && skip === 0 && currentRef) {
					references.push(currentRef);
				}
				if (index === 0 && skip === 0 && remoteRef) {
					references.push(remoteRef);
				}

				const authorDate = new Date(entry.date);
				const dateString = authorDate.toLocaleString(undefined, {
					year: 'numeric',
					month: 'long',
					day: 'numeric',
					hour: 'numeric',
					minute: 'numeric'
				});
				const relativeDate = this._fromNow(authorDate);

				const tooltip: MarkdownString[] = [];

				// Section 1: Author + message
				const authorMd = new MarkdownString('', { supportThemeIcons: true, supportHtml: true });
				authorMd.appendMarkdown('$(account) [**');
				authorMd.appendText(entry.author);
				authorMd.appendMarkdown('**](mailto:');
				authorMd.appendText(entry.email ?? entry.author);
				authorMd.appendMarkdown(')');
				if (!isNaN(authorDate.getTime())) {
					authorMd.appendMarkdown(', $(history)');
					authorMd.appendText(` ${relativeDate} (${dateString})`);
				}
				authorMd.appendMarkdown('\n\n');
				authorMd.appendMarkdown(entry.message.replace(/!\[/g, '&#33;&#91;').replace(/\r\n|\r|\n/g, '\n\n'));
				authorMd.appendMarkdown('\n\n---\n\n');
				tooltip.push(authorMd);

				// Section 2: Stats
				if (entry.files_changed !== undefined) {
					const statsMd = new MarkdownString('', { supportThemeIcons: true, supportHtml: true });
					const fc = entry.files_changed;
					statsMd.appendMarkdown(`<span>${fc === 1 ? `${fc} file changed` : `${fc} files changed`}</span>`);
					if (entry.insertions) {
						statsMd.appendMarkdown(
							`,&nbsp;<span style="color:var(--vscode-scmGraph-historyItemHoverAdditionsForeground);">${entry.insertions} insertion${entry.insertions === 1 ? '' : 's'}(+)</span>`
						);
					}
					if (entry.deletions) {
						statsMd.appendMarkdown(
							`,&nbsp;<span style="color:var(--vscode-scmGraph-historyItemHoverDeletionsForeground);">${entry.deletions} deletion${entry.deletions === 1 ? '' : 's'}(-)</span>`
						);
					}
					statsMd.appendMarkdown('\n\n---\n\n');
					tooltip.push(statsMd);
				}

				return {
					id: entry.hash,
					parentIds: entry.parent_hashes ?? [],
					subject: entry.message,
					message: entry.message,
					displayId: entry.hash.substring(0, 7),
					author: entry.author,
					authorEmail: entry.email,
					authorIcon: ThemeIcon.fromId('account'),
					timestamp: authorDate.getTime(),
					statistics:
						entry.files_changed !== undefined
							? {
									files: entry.files_changed,
									insertions: entry.insertions ?? 0,
									deletions: entry.deletions ?? 0
								}
							: undefined,
					references,
					tooltip
				} satisfies ISCMHistoryItem;
			});
		} catch (err) {
			this._logService.warn('[TauriGit] git_log failed', err);
			return [];
		}
	}

	async provideHistoryItemChanges(
		historyItemId: string,
		_historyItemParentId: string | undefined,
		_token?: CancellationToken
	): Promise<ISCMHistoryItemChange[] | undefined> {
		try {
			const parentRef = _historyItemParentId ?? `${historyItemId}~1`;

			const invoke = await getTauriInvoke();
			if (!invoke) {
				return [];
			}

			let nameOutput: string;
			try {
				nameOutput = (await invoke('git_run', {
					path: this._rootPath,
					args: ['diff-tree', '--no-commit-id', '-r', '--name-status', parentRef, historyItemId]
				})) as string;
			} catch {
				try {
					nameOutput = (await invoke('git_run', {
						path: this._rootPath,
						args: ['diff-tree', '--no-commit-id', '-r', '--name-only', historyItemId]
					})) as string;
				} catch {
					return [];
				}
			}

			if (!nameOutput || !nameOutput.trim()) {
				return [];
			}

			return nameOutput
				.trim()
				.split('\n')
				.filter(line => line.trim())
				.map(line => {
					const parts = line.split('\t');
					const filePath = parts.length > 1 ? parts[parts.length - 1] : parts[0];
					const fileUri = URI.joinPath(this._rootUri, filePath.trim());
					return {
						uri: fileUri,
						originalUri: fileUri.with({ scheme: GIT_ORIGINAL_SCHEME, query: parentRef }),
						modifiedUri: fileUri.with({ scheme: GIT_ORIGINAL_SCHEME, query: historyItemId })
					} satisfies ISCMHistoryItemChange;
				});
		} catch (err) {
			this._logService.warn('[TauriGit] provideHistoryItemChanges failed', err);
			return [];
		}
	}

	async resolveHistoryItem(historyItemId: string, _token?: CancellationToken): Promise<ISCMHistoryItem | undefined> {
		const items = await this.provideHistoryItems({ limit: 100 });
		return items?.find(item => item.id === historyItemId);
	}

	async resolveHistoryItemChatContext(_historyItemId: string, _token?: CancellationToken): Promise<string | undefined> {
		return undefined;
	}

	async resolveHistoryItemChangeRangeChatContext(
		_historyItemId: string,
		_historyItemParentId: string,
		_path: string,
		_token?: CancellationToken
	): Promise<string | undefined> {
		return undefined;
	}

	private _fromNow(date: Date): string {
		const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
		if (seconds < 60) {
			return 'just now';
		}
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) {
			return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
		}
		const hours = Math.floor(minutes / 60);
		if (hours < 24) {
			return `${hours} hour${hours === 1 ? '' : 's'} ago`;
		}
		const days = Math.floor(hours / 24);
		if (days < 30) {
			return `${days} day${days === 1 ? '' : 's'} ago`;
		}
		const months = Math.floor(days / 30);
		if (months < 12) {
			return `${months} month${months === 1 ? '' : 's'} ago`;
		}
		const years = Math.floor(months / 12);
		return `${years} year${years === 1 ? '' : 's'} ago`;
	}

	async resolveHistoryItemRefsCommonAncestor(
		_historyItemRefs: string[],
		_token?: CancellationToken
	): Promise<string | undefined> {
		if (_historyItemRefs.length < 2) {
			return _historyItemRefs[0];
		}
		try {
			const invoke = await getTauriInvoke();
			if (!invoke) {
				return undefined;
			}
			const result = (
				(await invoke('git_run', {
					path: this._rootPath,
					args: ['merge-base', _historyItemRefs[0], _historyItemRefs[1]]
				})) as string
			).trim();
			return result || undefined;
		} catch {
			return undefined;
		}
	}
}

// ─── SCM Provider ───────────────────────────────────────────────────────────

class TauriGitSCMProvider extends Disposable implements ISCMProvider {
	readonly id: string;
	readonly providerId = 'git';
	readonly label = 'Git';
	readonly name: string;
	readonly rootUri: URI;
	readonly iconPath = ThemeIcon.fromId('repo');
	readonly isHidden = false;
	readonly inputBoxTextModel: ITextModel;

	private readonly _contextValue = observableValue<string | undefined>(this, 'git');
	get contextValue(): IObservable<string | undefined> {
		return this._contextValue;
	}

	private readonly _count = observableValue<number | undefined>(this, undefined);
	get count(): IObservable<number | undefined> {
		return this._count;
	}

	private readonly _commitTemplate = observableValue<string>(this, '');
	get commitTemplate(): IObservable<string> {
		return this._commitTemplate;
	}

	private readonly _actionButton = observableValue<ISCMActionButtonDescriptor | undefined>(this, undefined);
	get actionButton(): IObservable<ISCMActionButtonDescriptor | undefined> {
		return this._actionButton;
	}

	private readonly _statusBarCommands = observableValue<readonly Command[] | undefined>(this, undefined);
	get statusBarCommands(): IObservable<readonly Command[] | undefined> {
		return this._statusBarCommands;
	}

	private readonly _artifactProvider = observableValue<ISCMArtifactProvider | undefined>(this, undefined);
	get artifactProvider(): IObservable<ISCMArtifactProvider | undefined> {
		return this._artifactProvider;
	}

	private readonly _historyProvider = observableValue<ISCMHistoryProvider | undefined>(this, undefined);
	get historyProvider(): IObservable<ISCMHistoryProvider | undefined> {
		return this._historyProvider;
	}

	readonly acceptInputCommand: Command = {
		id: 'git.commit',
		title: 'Commit'
	};

	private readonly _mergeGroup: TauriGitResourceGroup;
	private readonly _stagedGroup: TauriGitResourceGroup;
	private readonly _changesGroup: TauriGitResourceGroup;
	readonly groups: TauriGitResourceGroup[];
	private _historyProviderInstance: TauriGitHistoryProvider | undefined;

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
		private readonly logService: ILogService
	) {
		super();

		this.rootUri = rootUri;
		this.id = `git:${rootUri.toString()}`;
		this.name = basename(rootUri) || 'Git';

		const inputUri = URI.from({ scheme: Schemas.vscodeSourceControl, path: `/${this.id}/input` });
		let model = modelService.getModel(inputUri);
		if (!model) {
			model = modelService.createModel('', languageService.createById('scminput'), inputUri);
		}
		this.inputBoxTextModel = model;

		this._mergeGroup = new TauriGitResourceGroup('merge', 'Merge Changes', this, uriIdentityService, true);
		this._stagedGroup = new TauriGitResourceGroup('staged', 'Staged Changes', this, uriIdentityService, true);
		this._changesGroup = new TauriGitResourceGroup('changes', 'Changes', this, uriIdentityService, false);
		this.groups = [this._mergeGroup, this._stagedGroup, this._changesGroup];

		this._register(this._onDidChangeResourceGroups);
		this._register(this._onDidChangeResources);
		this._register(this._mergeGroup._onDidChange);
		this._register(this._mergeGroup._onDidChangeResources);
		this._register(this._stagedGroup._onDidChange);
		this._register(this._stagedGroup._onDidChangeResources);
		this._register(this._changesGroup._onDidChange);
		this._register(this._changesGroup._onDidChangeResources);
	}

	setupHistoryProvider(): void {
		this._historyProviderInstance = new TauriGitHistoryProvider(this.rootUri.fsPath, this.rootUri, this.logService);
		this._historyProvider.set(this._historyProviderInstance, undefined);

		this._historyProviderInstance._detectGitHubUrl().then(url => {
			(this as any)._historyProviderGitHubUrl = url;
		});
	}

	async getOriginalResource(uri: URI): Promise<URI | null> {
		const relPath = relativePath(this.rootUri, uri);
		if (!relPath) {
			return null;
		}
		return URI.from({ scheme: GIT_ORIGINAL_SCHEME, path: `/${relPath}` });
	}

	async refresh(): Promise<void> {
		const rootPath = this.rootUri.fsPath;
		let status: TauriGitStatus | undefined;
		try {
			status = await invokeGit<TauriGitStatus>('git_status', { path: rootPath });
		} catch (err) {
			this.logService.warn('[TauriGit] git_status failed', err);
			return;
		}

		if (!status) {
			return;
		}

		this._branch = status.branch;

		if (this._historyProviderInstance) {
			try {
				const logEntries = await invokeGit<TauriGitLogEntry[]>('git_log', { path: rootPath, limit: 1 });
				const headHash = logEntries?.[0]?.hash;
				this._historyProviderInstance.updateRef(this._branch, headHash);
			} catch {
				this._historyProviderInstance.updateRef(this._branch);
			}
		}

		const mergeResources: ISCMResource[] = [];
		const stagedResources: ISCMResource[] = [];
		const changesResources: ISCMResource[] = [];

		const CONFLICT_XY_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
		const isConflictStatus = (status: string): boolean =>
			status === 'conflicted' || status === 'conflict' || CONFLICT_XY_CODES.has(status);

		for (const change of status.changes) {
			const fileUri = URI.joinPath(this.rootUri, change.path);
			if (isConflictStatus(change.status)) {
				mergeResources.push(new TauriGitResource(this._mergeGroup, fileUri, change.status, false, this.rootUri));
			} else if (change.staged) {
				stagedResources.push(new TauriGitResource(this._stagedGroup, fileUri, change.status, true, this.rootUri));
			} else {
				changesResources.push(new TauriGitResource(this._changesGroup, fileUri, change.status, false, this.rootUri));
			}
		}

		this._mergeGroup.setResources(mergeResources);
		this._stagedGroup.setResources(stagedResources);
		this._changesGroup.setResources(changesResources);

		// Fire provider-level change events so the SCM view updates
		this._onDidChangeResources.fire();
		this._onDidChangeResourceGroups.fire();

		const total = mergeResources.length + stagedResources.length + changesResources.length;
		this._count.set(total, undefined);

		let ahead = 0;
		let behind = 0;
		try {
			const invoke = await getTauriInvoke();
			if (invoke) {
				const output = (
					(await invoke('git_run', {
						path: rootPath,
						args: ['rev-list', '--left-right', '--count', `HEAD...@{upstream}`]
					})) as string
				).trim();
				const parts = output.split(/\s+/);
				ahead = parseInt(parts[0], 10) || 0;
				behind = parseInt(parts[1], 10) || 0;
			}
		} catch {
			// No upstream configured or remote unreachable
		}

		this._statusBarCommands.set(
			[
				{
					id: 'git.checkoutTo',
					title: `$(git-branch) ${this._branch}${total > 0 ? '*' : ''}`,
					tooltip: `Branch: ${this._branch}${total > 0 ? ' (modified)' : ''}`
				},
				{
					id: 'git.sync',
					title: ahead > 0 || behind > 0 ? `$(sync) ${behind}$(arrow-down) ${ahead}$(arrow-up)` : '$(sync)',
					tooltip: 'Synchronize Changes'
				}
			],
			undefined
		);

		if (total === 0 && ahead > 0) {
			const syncLabel =
				behind > 0
					? `$(sync) Sync Changes ${behind}$(arrow-down) ${ahead}$(arrow-up)`
					: `$(sync) Sync Changes ${ahead}$(arrow-up)`;
			this._actionButton.set(
				{
					command: { id: 'git.sync', title: syncLabel },
					secondaryCommands: [
						[
							{ id: 'git.sync', title: 'Sync' },
							{ id: 'git.push', title: 'Push' },
							{ id: 'git.pull', title: 'Pull' }
						]
					],
					enabled: true
				},
				undefined
			);
		} else {
			this._actionButton.set(
				{
					command: { id: 'git.commit', title: '$(check) Commit' },
					secondaryCommands: [
						[
							{ id: 'git.commit', title: 'Commit' },
							{ id: 'git.commitAmend', title: 'Commit (Amend)' }
						],
						[
							{ id: 'git.commitAndPush', title: 'Commit & Push' },
							{ id: 'git.commitAndSync', title: 'Commit & Sync' }
						]
					],
					enabled: true
				},
				undefined
			);
		}

		this._onDidChangeResources.fire();
	}
}

// ─── Git Decoration Colors ──────────────────────────────────────────────────

const gitDecorationModifiedFg = registerColor(
	'gitDecoration.modifiedResourceForeground',
	{ dark: '#E2C08D', light: '#895503', hcDark: '#E2C08D', hcLight: '#895503' },
	'Color for modified git resources.'
);
const gitDecorationDeletedFg = registerColor(
	'gitDecoration.deletedResourceForeground',
	{ dark: '#c74e39', light: '#ad0707', hcDark: '#c74e39', hcLight: '#ad0707' },
	'Color for deleted git resources.'
);
const gitDecorationUntrackedFg = registerColor(
	'gitDecoration.untrackedResourceForeground',
	{ dark: '#73C991', light: '#007100', hcDark: '#73C991', hcLight: '#007100' },
	'Color for untracked git resources.'
);
const gitDecorationAddedFg = registerColor(
	'gitDecoration.addedResourceForeground',
	{ dark: '#81b88b', light: '#587c0c', hcDark: '#a1e3ad', hcLight: '#374e06' },
	'Color for added git resources.'
);
const gitDecorationRenamedFg = registerColor(
	'gitDecoration.renamedResourceForeground',
	{ dark: '#73C991', light: '#007100', hcDark: '#73C991', hcLight: '#007100' },
	'Color for renamed git resources.'
);
const gitDecorationIgnoredFg = registerColor(
	'gitDecoration.ignoredResourceForeground',
	{ dark: '#8C8C8C', light: '#8E8E90', hcDark: '#A7A8A9', hcLight: '#8e8e90' },
	'Color for ignored git resources.'
);
const gitDecorationStageModifiedFg = registerColor(
	'gitDecoration.stageModifiedResourceForeground',
	{ dark: '#E2C08D', light: '#895503', hcDark: '#E2C08D', hcLight: '#895503' },
	'Color for staged modified git resources.'
);
const gitDecorationStageDeletedFg = registerColor(
	'gitDecoration.stageDeletedResourceForeground',
	{ dark: '#c74e39', light: '#ad0707', hcDark: '#c74e39', hcLight: '#ad0707' },
	'Color for staged deleted git resources.'
);
const gitDecorationConflictingFg = registerColor(
	'gitDecoration.conflictingResourceForeground',
	{ dark: '#e4676b', light: '#ad0707', hcDark: '#c74e39', hcLight: '#ad0707' },
	'Color for conflicting git resources.'
);
const gitDecorationSubmoduleFg = registerColor(
	'gitDecoration.submoduleResourceForeground',
	{ dark: '#8db9e2', light: '#1258a7', hcDark: '#8db9e2', hcLight: '#1258a7' },
	'Color for submodule git resources.'
);

// ─── Git File Decoration Provider ───────────────────────────────────────────

class TauriGitDecorationProvider implements IDecorationsProvider {
	readonly label = 'Git';

	private readonly _onDidChange = new Emitter<readonly URI[]>();
	readonly onDidChange: Event<readonly URI[]> = this._onDidChange.event;

	private _decorationMap = new Map<string, { status: string; staged: boolean }>();

	updateResources(resources: { uri: URI; status: string; staged: boolean }[]): void {
		const previousUris = new Set(this._decorationMap.keys());
		this._decorationMap.clear();
		const changedUris: URI[] = [];
		for (const r of resources) {
			const key = r.uri.toString();
			this._decorationMap.set(key, { status: r.status, staged: r.staged });
			previousUris.delete(key);
			changedUris.push(r.uri);
		}
		for (const removedKey of previousUris) {
			changedUris.push(URI.parse(removedKey));
		}
		this._onDidChange.fire(changedUris);
	}

	provideDecorations(uri: URI, _token: CancellationToken): IDecorationData | undefined {
		const entry = this._decorationMap.get(uri.toString());
		if (!entry) {
			return undefined;
		}
		switch (entry.status) {
			case 'modified':
				return {
					letter: 'M',
					color: entry.staged ? gitDecorationStageModifiedFg : gitDecorationModifiedFg,
					tooltip: entry.staged ? 'Index Modified' : 'Modified',
					strikethrough: false,
					bubble: true
				};
			case 'added':
			case 'new file':
				return {
					letter: 'A',
					color: gitDecorationAddedFg,
					tooltip: entry.staged ? 'Index Added' : 'Added',
					strikethrough: false,
					bubble: true
				};
			case 'deleted':
				return {
					letter: 'D',
					color: entry.staged ? gitDecorationStageDeletedFg : gitDecorationDeletedFg,
					tooltip: entry.staged ? 'Index Deleted' : 'Deleted',
					strikethrough: false,
					bubble: false
				};
			case 'renamed':
				return {
					letter: 'R',
					color: gitDecorationRenamedFg,
					tooltip: 'Index Renamed',
					strikethrough: false,
					bubble: true
				};
			case 'untracked':
				return {
					letter: 'U',
					color: gitDecorationUntrackedFg,
					tooltip: 'Untracked',
					strikethrough: false,
					bubble: true
				};
			case 'conflict':
			case 'conflicted':
				return {
					letter: '!',
					color: gitDecorationConflictingFg,
					tooltip: 'Conflict',
					strikethrough: false,
					bubble: true
				};
			default:
				return undefined;
		}
	}

	dispose(): void {
		this._onDidChange.dispose();
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
		@IFileService private readonly fileService: IFileService,
		@IDecorationsService private readonly decorationsService: IDecorationsService,
		@IQuickInputService quickInputService: IQuickInputService
	) {
		super();
		(globalThis as any).__sidex_quickInputService = quickInputService;
		this._init();
	}

	private async _init(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;

		(window as any).__sidex_workspaceFolders = folders.map(f => f.uri.fsPath);

		if (folders.length === 0) {
			return;
		}

		const rootUri = folders[0].uri;
		const rootPath = rootUri.fsPath;
		const originalProvider = new TauriGitOriginalFileProvider(rootPath);
		try {
			this._register(this.fileService.registerProvider(GIT_ORIGINAL_SCHEME, originalProvider));
		} catch {}

		let isRepo: boolean | undefined;
		try {
			isRepo = await invokeGit<boolean>('git_is_repo', { path: rootPath });
		} catch (err) {
			this.logService.info('[TauriGit] git_is_repo unavailable — Tauri backend not present', err);
			return;
		}

		if (!isRepo) {
			return;
		}

		const provider = new TauriGitSCMProvider(
			rootUri,
			this.modelService,
			this.languageService,
			this.uriIdentityService,
			this.logService
		);

		const repository = this.scmService.registerSCMProvider(provider);
		this._register(repository);
		this._register(provider);

		// Set the commit message placeholder
		repository.input.placeholder = `Message (⌘Enter to commit on "${provider.name}")`;

		this._registerDiffCommands(provider, rootPath);
		this._registerCommitCommand(provider, rootPath);

		provider.setupHistoryProvider();

		// Register git file decoration provider (letter badges: M, D, A, U, R)
		const gitDecoProvider = new TauriGitDecorationProvider();
		this._register(this.decorationsService.registerDecorationsProvider(gitDecoProvider));
		this._register(gitDecoProvider);

		const updateDecorations = () => {
			const allResources: { uri: URI; status: string; staged: boolean }[] = [];
			for (const group of provider.groups) {
				for (const resource of group.resources) {
					const tauriRes = resource as TauriGitResource;
					allResources.push({
						uri: tauriRes.sourceUri,
						status: tauriRes.statusLabel,
						staged: group.id === 'staged'
					});
				}
			}
			gitDecoProvider.updateResources(allResources);
		};

		provider.onDidChangeResources(updateDecorations);

		await provider.refresh();

		this._pollHandle = setInterval(() => provider.refresh(), 10000);
		this._register({
			dispose: () => {
				if (this._pollHandle !== undefined) {
					clearInterval(this._pollHandle);
					this._pollHandle = undefined;
				}
			}
		});
	}

	private _registerDiffCommands(provider: TauriGitSCMProvider, rootPath: string): void {
		this._register(
			CommandsRegistry.registerCommand('git.openDiff', async (_accessor, ...args: any[]) => {
				try {
					const commandService = (globalThis as any).__sidex_commandService;
					if (!commandService) {
						return;
					}

					const resource = args[0];
					const sourceUri: URI | undefined = resource?.sourceUri ?? resource;
					if (!sourceUri) {
						return;
					}

					const relPath = relativePath(provider.rootUri, sourceUri) ?? sourceUri.path;
					const originalUri = URI.from({ scheme: GIT_ORIGINAL_SCHEME, path: `/${relPath}` });
					const modifiedUri = sourceUri;
					const fileName = basename(sourceUri);
					const title = `${fileName} (Working Tree)`;

					await commandService.executeCommand('vscode.diff', originalUri, modifiedUri, title);
				} catch (err) {
					console.error('[TauriGit] open diff failed:', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.openChange', async (_accessor, ...args: any[]) => {
				try {
					const commandService = (globalThis as any).__sidex_commandService;
					if (!commandService) {
						return;
					}

					const resource = args[0];
					const sourceUri: URI | undefined = resource?.sourceUri ?? resource;
					if (!sourceUri) {
						return;
					}

					const relPath = relativePath(provider.rootUri, sourceUri) ?? sourceUri.path;
					const originalUri = URI.from({ scheme: GIT_ORIGINAL_SCHEME, path: `/${relPath}` });
					const modifiedUri = sourceUri;
					const fileName = basename(sourceUri);
					const title = `${fileName} (Index)`;

					await commandService.executeCommand('vscode.diff', originalUri, modifiedUri, title);
				} catch (err) {
					console.error('[TauriGit] open change failed:', err);
				}
			})
		);
	}

	private _registerCommitCommand(provider: TauriGitSCMProvider, rootPath: string): void {
		this._register(
			CommandsRegistry.registerCommand('git.commit', async () => {
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
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.stageAll', async () => {
				try {
					await invokeGit('git_add', { path: rootPath, files: ['.'] });
					await provider.refresh();
				} catch (err) {
					this.logService.error('[TauriGit] stage all failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.refresh', async () => {
				await provider.refresh();
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.discardAll', async () => {
				try {
					const invoke = await getTauriInvoke();
					if (invoke) {
						await invoke('git_restore', {
							path: rootPath,
							files: ['.'],
							source: 'HEAD',
							staged: false,
							worktree: true
						});
						await invoke('git_clean', { path: rootPath, files: ['.'], dirs: true });
					}
					await provider.refresh();
				} catch (err) {
					this.logService.error('[TauriGit] discard all failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.openAllChanges', async () => {
				try {
					const commandService = (globalThis as any).__sidex_commandService;
					if (!commandService) {
						return;
					}
					const status = await invokeGit<TauriGitStatus>('git_status', { path: rootPath });
					if (!status) {
						return;
					}
					for (const change of status.changes) {
						const fileUri = URI.joinPath(provider.rootUri, change.path);
						if (change.status === 'untracked' || change.status === 'added') {
							await commandService.executeCommand('vscode.open', fileUri);
						} else {
							const relPath = change.path;
							const originalUri = URI.from({ scheme: GIT_ORIGINAL_SCHEME, path: `/${relPath}` });
							const fileName = basename(fileUri);
							await commandService.executeCommand('vscode.diff', originalUri, fileUri, `${fileName} (Working Tree)`);
						}
					}
				} catch (err) {
					console.error('[TauriGit] open all changes failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.stageFile', async (_accessor, ...args: any[]) => {
				try {
					const resource = args[0];
					const uri = resource?.sourceUri ?? resource;
					if (uri?.fsPath) {
						await invokeGit('git_add', { path: rootPath, files: [uri.fsPath] });
						await provider.refresh();
					}
				} catch (err) {
					console.error('[TauriGit] stage file failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.discardFile', async (_accessor, ...args: any[]) => {
				try {
					const resource = args[0];
					const uri: URI | undefined = resource?.sourceUri ?? resource;
					if (!uri?.fsPath) {
						return;
					}

					const status = (resource as any)?._status ?? '';
					const isUntracked = typeof status === 'string' && (status === 'untracked' || status.includes('?'));

					const relPath = uri.fsPath.startsWith(rootPath + '/')
						? uri.fsPath.substring(rootPath.length + 1)
						: uri.fsPath;

					const invoke = await getTauriInvoke();
					if (invoke) {
						if (isUntracked) {
							await invoke('git_clean', { path: rootPath, files: [relPath], dirs: false });
						} else {
							await invoke('git_restore', {
								path: rootPath,
								files: [relPath],
								source: null,
								staged: false,
								worktree: true
							});
						}
					}
					await provider.refresh();
				} catch (err) {
					console.error('[TauriGit] discard file failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.openFile', async (_accessor, ...args: any[]) => {
				try {
					const resource = args[0];
					const uri = resource?.sourceUri ?? resource;
					if (uri) {
						const commandService = (globalThis as any).__sidex_commandService;
						if (commandService) {
							const status = (resource as any)?._status;
							if (status && status !== 'untracked' && status !== 'added' && status !== 'deleted') {
								await commandService.executeCommand('git.openDiff', resource);
							} else {
								await commandService.executeCommand('vscode.open', uri);
							}
						}
					}
				} catch (err) {
					console.error('[TauriGit] open file failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.unstageFile', async (_accessor, ...args: any[]) => {
				try {
					const resource = args[0];
					const uri = resource?.sourceUri ?? resource;
					if (uri?.fsPath) {
						await invokeGit('git_reset', { path: rootPath, files: [uri.fsPath] });
						await provider.refresh();
					}
				} catch (err) {
					console.error('[TauriGit] unstage file failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.unstageAll', async () => {
				try {
					await invokeGit('git_reset', { path: rootPath, files: ['.'] });
					await provider.refresh();
				} catch (err) {
					console.error('[TauriGit] unstage all failed', err);
				}
			})
		);
	}
}

// Register git.init command globally so the "Initialize Repository" button works
CommandsRegistry.registerCommand('git.init', async () => {
	try {
		const invoke = await getTauriInvoke();
		if (!invoke) {
			return;
		}

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

		if (!targetPath) {
			return;
		}

		await invoke('git_init', { path: targetPath });
		console.log('[TauriGit] Repository initialized at', targetPath);

		// Reload to pick up the new git repo
		window.location.reload();
	} catch (err) {
		console.error('[TauriGit] git init failed:', err);
	}
});

CommandsRegistry.registerCommand('git.copyToClipboard', async (_accessor, content: string) => {
	if (typeof content !== 'string') {
		return;
	}
	try {
		await navigator.clipboard.writeText(content);
	} catch {
		console.error('[TauriGit] clipboard write failed');
	}
});

CommandsRegistry.registerCommand('git.openOnGitHub', async (_accessor, remoteUrl: string, hash: string) => {
	try {
		const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
		if (!match) {
			return;
		}
		const commitUrl = `https://github.com/${match[1]}/commit/${hash}`;
		const openerService = (globalThis as any).__sidex_openerService;
		if (openerService) {
			await openerService.open(URI.parse(commitUrl), { openExternal: true });
		} else {
			window.open(commitUrl, '_blank');
		}
	} catch (err) {
		console.error('[TauriGit] open on GitHub failed:', err);
	}
});

registerWorkbenchContribution2(TauriGitContribution.ID, TauriGitContribution, WorkbenchPhase.BlockRestore);

// ─── Repository-level commands ──────────────────────────────────────────────

function getWorkspacePath(): string | undefined {
	const folders = (window as any).__sidex_workspaceFolders;
	return folders && folders.length > 0 ? folders[0] : undefined;
}

CommandsRegistry.registerCommand('git.pull', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const result = await invokeGit<string>('git_pull', { path });
		console.log('[TauriGit] pull:', result);
	} catch (err) {
		console.error('[TauriGit] pull failed:', err);
	}
});

CommandsRegistry.registerCommand('git.push', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const result = await invokeGit<string>('git_push', { path });
		console.log('[TauriGit] push:', result);
	} catch (err) {
		console.error('[TauriGit] push failed:', err);
	}
});

CommandsRegistry.registerCommand('git.fetch', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const result = await invokeGit<string>('git_fetch', { path });
		console.log('[TauriGit] fetch:', result);
	} catch (err) {
		console.error('[TauriGit] fetch failed:', err);
	}
});

async function doGitClone(): Promise<void> {
	try {
		const quickInputService = (globalThis as any).__sidex_quickInputService;
		if (!quickInputService) {
			return;
		}

		const url = await quickInputService.input({
			placeHolder: 'Repository URL to clone (e.g. https://github.com/user/repo.git)'
		});
		if (!url) {
			return;
		}

		const { open } = await import('@tauri-apps/plugin-dialog');
		const dest = await open({ directory: true, title: 'Choose destination folder for clone' });
		if (!dest || typeof dest !== 'string') {
			return;
		}

		await invokeGit('git_clone', { url, path: dest });
		console.log('[TauriGit] cloned', url, 'to', dest);

		const newUrl = new URL(window.location.href);
		newUrl.searchParams.set('folder', URI.file(dest).toString());
		window.location.href = newUrl.toString();
	} catch (err) {
		console.error('[TauriGit] clone failed:', err);
	}
}

CommandsRegistry.registerCommand('git.clone', doGitClone);

CommandsRegistry.registerCommand('git.checkoutTo', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (!invoke) {
			return;
		}

		const quickInputService = (globalThis as any).__sidex_quickInputService;
		if (!quickInputService) {
			return;
		}

		// Get local branches
		let branchOutput = '';
		try {
			branchOutput = (
				(await invoke('git_run', {
					path,
					args: [
						'branch',
						'--format=%(refname:short)|%(objectname:short)|%(committerdate:relative)|%(authorname)|%(subject)'
					]
				})) as string
			).trim();
		} catch {
			/* no branches */
		}

		// Get remote branches
		let remoteOutput = '';
		try {
			remoteOutput = (
				(await invoke('git_run', {
					path,
					args: [
						'branch',
						'-r',
						'--format=%(refname:short)|%(objectname:short)|%(committerdate:relative)|%(authorname)|%(subject)'
					]
				})) as string
			).trim();
		} catch {
			/* no remotes */
		}

		const items: any[] = [];

		items.push({ label: '$(add) Create new branch...', branch: '__create__', alwaysShow: true });
		items.push({ label: '$(add) Create new branch from...', branch: '__create_from__', alwaysShow: true });
		items.push({ label: '$(git-compare) Checkout detached...', branch: '__detached__', alwaysShow: true });

		if (branchOutput) {
			items.push({ type: 'separator', label: 'branches' });
			for (const line of branchOutput.split('\n')) {
				const parts = line.split('|');
				const name = parts[0] || '';
				if (!name) {
					continue;
				}
				items.push({
					label: `$(git-branch) ${name}`,
					description: parts[2] || '',
					detail: `${parts[3] || ''} • ${parts[1] || ''} • ${parts[4] || ''}`,
					branch: name
				});
			}
		}

		if (remoteOutput) {
			items.push({ type: 'separator', label: 'remote branches' });
			for (const line of remoteOutput.split('\n')) {
				const parts = line.split('|');
				const name = parts[0] || '';
				if (!name || name.includes('HEAD')) {
					continue;
				}
				items.push({
					label: `$(cloud) ${name}`,
					description: parts[2] || '',
					detail: `${parts[3] || ''} • ${parts[1] || ''} • ${parts[4] || ''}`,
					branch: name
				});
			}
		}

		// Get tags
		let tagsOutput = '';
		try {
			tagsOutput = (
				(await invoke('git_run', {
					path,
					args: [
						'tag',
						'--sort=-creatordate',
						'--format=%(refname:short)|%(objectname:short)|%(creatordate:relative)|%(creatorname)|%(subject)'
					]
				})) as string
			).trim();
		} catch {
			/* no tags */
		}

		if (tagsOutput) {
			items.push({ type: 'separator', label: 'tags' });
			for (const line of tagsOutput.split('\n')) {
				const parts = line.split('|');
				const name = parts[0] || '';
				if (!name) {
					continue;
				}
				items.push({
					label: `$(tag) ${name}`,
					description: parts[2] || '',
					detail: `${parts[3] || ''} • ${parts[1] || ''} • ${parts[4] || ''}`,
					branch: name
				});
			}
		}

		const picked = await quickInputService.pick(items, {
			placeHolder: 'Select a branch or tag to checkout',
			matchOnDescription: true,
			matchOnDetail: true
		});

		if (!picked || !picked.branch) {
			return;
		}

		if (picked.branch === '__create__') {
			const name = await quickInputService.input({ placeHolder: 'Branch name' });
			if (!name) {
				return;
			}
			await invoke('git_run', { path, args: ['checkout', '-b', name] });
		} else if (picked.branch === '__create_from__') {
			const base = await quickInputService.input({ placeHolder: 'Base branch or commit' });
			if (!base) {
				return;
			}
			const name = await quickInputService.input({ placeHolder: 'New branch name' });
			if (!name) {
				return;
			}
			await invoke('git_run', { path, args: ['checkout', '-b', name, base] });
		} else if (picked.branch === '__detached__') {
			const ref = await quickInputService.input({ placeHolder: 'Commit hash, tag, or ref to checkout' });
			if (!ref) {
				return;
			}
			await invoke('git_run', { path, args: ['checkout', '--detach', ref] });
		} else {
			const branchName = picked.branch.replace(/^origin\//, '');
			await invoke('git_run', { path, args: ['checkout', branchName] });
		}

		window.location.reload();
	} catch (err) {
		console.error('[TauriGit] checkout failed:', err);
	}
});

CommandsRegistry.registerCommand('git.createBranch', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	const name = window.prompt('New branch name:');
	if (!name) {
		return;
	}
	try {
		await invokeGit('git_create_branch', { path, name });
		console.log('[TauriGit] created branch', name);
	} catch (err) {
		console.error('[TauriGit] create branch failed:', err);
	}
});

CommandsRegistry.registerCommand('git.sync', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		await invokeGit<string>('git_pull', { path });
		await invokeGit<string>('git_push', { path });
		console.log('[TauriGit] sync complete');
	} catch (err) {
		console.error('[TauriGit] sync failed:', err);
	}
});

CommandsRegistry.registerCommand('git.stash', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['stash'] });
			console.log('[TauriGit] stash complete');
		}
	} catch (err) {
		console.error('[TauriGit] stash failed:', err);
	}
});

CommandsRegistry.registerCommand('git.stashPop', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['stash', 'pop'] });
			console.log('[TauriGit] stash pop complete');
		}
	} catch (err) {
		console.error('[TauriGit] stash pop failed:', err);
	}
});

CommandsRegistry.registerCommand('git.stashPopLatest', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['stash', 'pop', 'stash@{0}'] });
			console.log('[TauriGit] stash pop latest complete');
		}
	} catch (err) {
		console.error('[TauriGit] stash pop latest failed:', err);
	}
});

CommandsRegistry.registerCommand('git.commitAmend', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['commit', '--amend', '--no-edit'] });
			console.log('[TauriGit] commit amend complete');
		}
	} catch (err) {
		console.error('[TauriGit] commit amend failed:', err);
	}
});

CommandsRegistry.registerCommand('git.commitAndPush', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			const message = (window as any).__sidex_scmInputValue?.() || '';
			if (!message.trim()) {
				return;
			}
			await invoke('git_run', { path, args: ['commit', '-m', message] });
			await invokeGit<string>('git_push', { path });
			console.log('[TauriGit] commit & push complete');
		}
	} catch (err) {
		console.error('[TauriGit] commit & push failed:', err);
	}
});

CommandsRegistry.registerCommand('git.commitAndSync', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			const message = (window as any).__sidex_scmInputValue?.() || '';
			if (!message.trim()) {
				return;
			}
			await invoke('git_run', { path, args: ['commit', '-m', message] });
			await invokeGit<string>('git_pull', { path });
			await invokeGit<string>('git_push', { path });
			console.log('[TauriGit] commit & sync complete');
		}
	} catch (err) {
		console.error('[TauriGit] commit & sync failed:', err);
	}
});

CommandsRegistry.registerCommand('git.commitAll', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['add', '.'] });
			const message = (window as any).__sidex_scmInputValue?.() || '';
			if (!message.trim()) {
				return;
			}
			await invoke('git_run', { path, args: ['commit', '-m', message] });
			console.log('[TauriGit] commit all complete');
		}
	} catch (err) {
		console.error('[TauriGit] commit all failed:', err);
	}
});

CommandsRegistry.registerCommand('git.addRemote', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	const name = window.prompt('Remote name:');
	if (!name) {
		return;
	}
	const url = window.prompt('Remote URL:');
	if (!url) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['remote', 'add', name, url] });
			console.log('[TauriGit] added remote', name);
		}
	} catch (err) {
		console.error('[TauriGit] add remote failed:', err);
	}
});

CommandsRegistry.registerCommand('git.removeRemote', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	const name = window.prompt('Remote name to remove:');
	if (!name) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['remote', 'remove', name] });
			console.log('[TauriGit] removed remote', name);
		}
	} catch (err) {
		console.error('[TauriGit] remove remote failed:', err);
	}
});

CommandsRegistry.registerCommand('git.createTag', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	const name = window.prompt('Tag name:');
	if (!name) {
		return;
	}
	const message = window.prompt('Tag message (leave empty for lightweight tag):');
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			const args = message ? ['tag', '-a', name, '-m', message] : ['tag', name];
			await invoke('git_run', { path, args });
			console.log('[TauriGit] created tag', name);
		}
	} catch (err) {
		console.error('[TauriGit] create tag failed:', err);
	}
});

CommandsRegistry.registerCommand('git.deleteTag', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	const name = window.prompt('Tag name to delete:');
	if (!name) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['tag', '-d', name] });
			console.log('[TauriGit] deleted tag', name);
		}
	} catch (err) {
		console.error('[TauriGit] delete tag failed:', err);
	}
});

CommandsRegistry.registerCommand('git.showOutput', async () => {
	try {
		const commandService = (globalThis as any).__sidex_commandService;
		if (commandService) {
			await commandService.executeCommand('workbench.action.output.toggleOutput');
		}
	} catch (err) {
		console.error('[TauriGit] show output failed:', err);
	}
});

// ─── SCM Source Control ("...") menu items ──────────────────────────────────

// Define submenus matching VS Code's Git extension
const SCMGitCommitMenu = new MenuId('SCMGitCommit');
const SCMGitChangesMenu = new MenuId('SCMGitChanges');
const SCMGitPullPushMenu = new MenuId('SCMGitPullPush');
const SCMGitBranchMenu = new MenuId('SCMGitBranch');
const SCMGitRemoteMenu = new MenuId('SCMGitRemote');
const SCMGitStashMenu = new MenuId('SCMGitStash');
const SCMGitTagsMenu = new MenuId('SCMGitTags');
const SCMRepoViewSortMenu = new MenuId('SCMRepoViewSort');

// Repository row "..." in REPOSITORIES view (SCMSourceControlInline)
// View & Sort submenu
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: 'View & Sort',
	submenu: SCMRepoViewSortMenu,
	group: '0_view&sort',
	order: 1
});

MenuRegistry.appendMenuItem(SCMRepoViewSortMenu, {
	command: { id: 'workbench.scm.action.setListViewMode', title: 'View as List' },
	group: '1_viewmode',
	order: 1
});
MenuRegistry.appendMenuItem(SCMRepoViewSortMenu, {
	command: { id: 'workbench.scm.action.setTreeViewMode', title: 'View as Tree' },
	group: '1_viewmode',
	order: 2
});

// Quick actions
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'git.pull', title: 'Pull' },
	group: '1_header',
	order: 1
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'git.push', title: 'Push' },
	group: '1_header',
	order: 2
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'git.clone', title: 'Clone...' },
	group: '1_header',
	order: 3
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'git.checkoutTo', title: 'Checkout to...' },
	group: '1_header',
	order: 4
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'git.fetch', title: 'Fetch' },
	group: '1_header',
	order: 5
});

// Submenus
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: 'Commit',
	submenu: SCMGitCommitMenu,
	group: '2_main',
	order: 1
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: 'Changes',
	submenu: SCMGitChangesMenu,
	group: '2_main',
	order: 2
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: 'Pull, Push',
	submenu: SCMGitPullPushMenu,
	group: '2_main',
	order: 3
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: 'Branch',
	submenu: SCMGitBranchMenu,
	group: '2_main',
	order: 4
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: 'Remote',
	submenu: SCMGitRemoteMenu,
	group: '2_main',
	order: 5
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: 'Stash',
	submenu: SCMGitStashMenu,
	group: '2_main',
	order: 6
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: 'Tags',
	submenu: SCMGitTagsMenu,
	group: '2_main',
	order: 7
});

// Footer
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'git.showOutput', title: 'Show Git Output' },
	group: '3_footer',
	order: 1
});

// Navigation toolbar buttons
MenuRegistry.appendMenuItem(MenuId.SCMTitle, {
	command: { id: 'git.commit', title: 'Commit', icon: ThemeIcon.fromId('check') },
	group: 'navigation',
	order: 1
});

MenuRegistry.appendMenuItem(MenuId.SCMTitle, {
	command: { id: 'git.refresh', title: 'Refresh', icon: ThemeIcon.fromId('refresh') },
	group: 'navigation',
	order: 2
});

// Graph view toolbar buttons
MenuRegistry.appendMenuItem(MenuId.SCMHistoryTitle, {
	command: { id: 'git.fetch', title: 'Fetch', icon: ThemeIcon.fromId('git-fetch') },
	group: 'navigation',
	order: 3
});

MenuRegistry.appendMenuItem(MenuId.SCMHistoryTitle, {
	command: { id: 'git.pull', title: 'Pull', icon: ThemeIcon.fromId('repo-pull') },
	group: 'navigation',
	order: 4
});

MenuRegistry.appendMenuItem(MenuId.SCMHistoryTitle, {
	command: { id: 'git.push', title: 'Push', icon: ThemeIcon.fromId('repo-push') },
	group: 'navigation',
	order: 5
});

// ─── Commit submenu items ───────────────────────────────────────────────────

MenuRegistry.appendMenuItem(SCMGitCommitMenu, {
	command: { id: 'git.commit', title: 'Commit' },
	group: '1_commit',
	order: 1
});

MenuRegistry.appendMenuItem(SCMGitCommitMenu, {
	command: { id: 'git.commitAll', title: 'Commit All' },
	group: '1_commit',
	order: 2
});

MenuRegistry.appendMenuItem(SCMGitCommitMenu, {
	command: { id: 'git.commitAmend', title: 'Commit (Amend)' },
	group: '2_amend',
	order: 1
});

// ─── Changes submenu items ──────────────────────────────────────────────────

MenuRegistry.appendMenuItem(SCMGitChangesMenu, {
	command: { id: 'git.stageAll', title: 'Stage All Changes' },
	group: 'changes',
	order: 1
});

MenuRegistry.appendMenuItem(SCMGitChangesMenu, {
	command: { id: 'git.unstageAll', title: 'Unstage All Changes' },
	group: 'changes',
	order: 2
});

MenuRegistry.appendMenuItem(SCMGitChangesMenu, {
	command: { id: 'git.discardAll', title: 'Discard All Changes' },
	group: 'changes',
	order: 3
});

// ─── Pull, Push submenu items ───────────────────────────────────────────────

MenuRegistry.appendMenuItem(SCMGitPullPushMenu, {
	command: { id: 'git.sync', title: 'Sync' },
	group: '1_sync',
	order: 1
});

MenuRegistry.appendMenuItem(SCMGitPullPushMenu, {
	command: { id: 'git.pull', title: 'Pull' },
	group: '2_pull',
	order: 1
});

MenuRegistry.appendMenuItem(SCMGitPullPushMenu, {
	command: { id: 'git.push', title: 'Push' },
	group: '3_push',
	order: 1
});

MenuRegistry.appendMenuItem(SCMGitPullPushMenu, {
	command: { id: 'git.fetch', title: 'Fetch' },
	group: '4_fetch',
	order: 1
});

// ─── Branch submenu items ───────────────────────────────────────────────────

MenuRegistry.appendMenuItem(SCMGitBranchMenu, {
	command: { id: 'git.createBranch', title: 'Create Branch...' },
	group: '1_branch',
	order: 1
});

MenuRegistry.appendMenuItem(SCMGitBranchMenu, {
	command: { id: 'git.checkoutTo', title: 'Checkout to...' },
	group: '1_branch',
	order: 2
});

// ─── Stash submenu items ────────────────────────────────────────────────────

MenuRegistry.appendMenuItem(SCMGitStashMenu, {
	command: { id: 'git.stash', title: 'Stash' },
	group: '1_stash',
	order: 1
});

MenuRegistry.appendMenuItem(SCMGitStashMenu, {
	command: { id: 'git.stashPopLatest', title: 'Pop Latest Stash' },
	group: '2_pop',
	order: 1
});

MenuRegistry.appendMenuItem(SCMGitStashMenu, {
	command: { id: 'git.stashPop', title: 'Pop Stash...' },
	group: '2_pop',
	order: 2
});

// ─── Remote submenu items ───────────────────────────────────────────────────

MenuRegistry.appendMenuItem(SCMGitRemoteMenu, {
	command: { id: 'git.addRemote', title: 'Add Remote...' },
	group: 'remote',
	order: 1
});

MenuRegistry.appendMenuItem(SCMGitRemoteMenu, {
	command: { id: 'git.removeRemote', title: 'Remove Remote...' },
	group: 'remote',
	order: 2
});

// ─── Tags submenu items ─────────────────────────────────────────────────────

MenuRegistry.appendMenuItem(SCMGitTagsMenu, {
	command: { id: 'git.createTag', title: 'Create Tag...' },
	group: 'tags',
	order: 1
});

MenuRegistry.appendMenuItem(SCMGitTagsMenu, {
	command: { id: 'git.deleteTag', title: 'Delete Tag...' },
	group: 'tags',
	order: 2
});

// Buttons on the "Changes" group header
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: { id: 'git.stageAll', title: 'Stage All Changes', icon: ThemeIcon.fromId('add') },
	group: 'inline',
	order: 3,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes')
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: { id: 'git.discardAll', title: 'Discard All Changes', icon: ThemeIcon.fromId('discard') },
	group: 'inline',
	order: 2,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes')
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: { id: 'git.openAllChanges', title: 'Open Changes', icon: ThemeIcon.fromId('diff-multiple') },
	group: 'inline',
	order: 1,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes')
});

// Buttons on the "Staged Changes" group header
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: { id: 'git.unstageAll', title: 'Unstage All Changes', icon: ThemeIcon.fromId('remove') },
	group: 'inline',
	order: 2,
	when: ContextKeyExpr.equals('scmResourceGroup', 'staged')
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: { id: 'git.openAllChanges', title: 'Open Staged Changes', icon: ThemeIcon.fromId('diff-multiple') },
	group: 'inline',
	order: 1,
	when: ContextKeyExpr.equals('scmResourceGroup', 'staged')
});

// Register buttons on individual changed files (stage, discard, open)
// Buttons on unstaged files: Open File, Discard, Stage
MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: { id: 'git.stageFile', title: 'Stage Changes', icon: ThemeIcon.fromId('add') },
	group: 'inline',
	order: 3,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes')
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: { id: 'git.discardFile', title: 'Discard Changes', icon: ThemeIcon.fromId('discard') },
	group: 'inline',
	order: 2,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes')
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: { id: 'git.openFile', title: 'Open File', icon: ThemeIcon.fromId('go-to-file') },
	group: 'inline',
	order: 1
});

// Buttons on staged files: Open File, Open Change, Unstage
MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: { id: 'git.unstageFile', title: 'Unstage Changes', icon: ThemeIcon.fromId('remove') },
	group: 'inline',
	order: 3,
	when: ContextKeyExpr.equals('scmResourceGroup', 'staged')
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: { id: 'git.openChange', title: 'Open Change', icon: ThemeIcon.fromId('git-compare') },
	group: 'inline',
	order: 1,
	when: ContextKeyExpr.equals('scmResourceGroup', 'staged')
});
