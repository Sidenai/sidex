import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import type { IMarkerData } from '../../../../platform/markers/common/markers.js';
import { IBulkEditService, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ILanguageConfigurationService } from '../../../../editor/common/languages/languageConfigurationRegistry.js';
import type { LanguageConfiguration } from '../../../../editor/common/languages/languageConfiguration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import type { IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import type { Position } from '../../../../editor/common/core/position.js';
import type { CancellationToken as _CancellationToken } from '../../../../base/common/cancellation.js';
import type {
	CompletionContext,
	CompletionItem,
	CompletionList,
	Hover,
	Location,
	DocumentSymbol,
	CodeActionList,
	CodeLensList,
	TextEdit,
	SignatureHelpResult,
	DocumentHighlight,
	WorkspaceEdit,
	Rejection,
	RenameLocation,
	FoldingRange,
	InlayHintList,
	IWorkspaceTextEdit,
	ILinksList,
	IColorInformation,
	IColorPresentation as _IColorPresentation,
	SelectionRange,
	SemanticTokens,
	SemanticTokensLegend,
} from '../../../../editor/common/languages.js';
import {
	CompletionItemKind,
	DocumentHighlightKind,
	SymbolKind,
} from '../../../../editor/common/languages.js';
import type { LanguageSelector } from '../../../../editor/common/languageSelector.js';
import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import {
	bootstrapExtensionPlatform,
	wasmSyncDocument,
	wasmCloseDocument,
	wasmSyncWorkspaceFolders,
	wasmProvideCompletionAll,
	wasmProvideHoverAll,
	wasmProvideDefinitionAll,
	wasmProvideDocumentSymbolsAll,
	wasmProvideFormattingAll,
	type IExtensionPlatformBootstrap,
	type IExtensionManifestSummary,
} from './extensionPlatformClient.js';
import { listen } from '@tauri-apps/api/event';
import { ITerminalService, ITerminalGroupService } from '../../terminal/browser/terminal.js';
import { INotificationService, Severity as _Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IDebugService } from '../../debug/common/debug.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import type { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ViewExtensions, type IViewsRegistry, type ITreeViewDescriptor, type ITreeViewDataProvider as _ITreeViewDataProvider, type ITreeItem as _ITreeItem } from '../../../common/views.js';
import { TreeView, TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import type { InstallExtensionResult, IGalleryExtension } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWebviewViewService } from '../../webviewView/browser/webviewViewService.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IWebviewService } from '../../webview/browser/webview.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';



function modelToParams(model: ITextModel, position: Position) {
	return {
		uri: model.uri.toString(),
		languageId: model.getLanguageId(),
		version: model.getVersionId(),
		position: { line: position.lineNumber - 1, character: position.column - 1 },
	};
}

function toVscPosition(pos: { line: number; character: number }): { lineNumber: number; column: number } {
	return { lineNumber: pos.line + 1, column: pos.character + 1 };
}

function toVscRange(r: { start: { line: number; character: number }; end: { line: number; character: number } }) {
	return {
		startLineNumber: r.start.line + 1,
		startColumn: r.start.character + 1,
		endLineNumber: r.end.line + 1,
		endColumn: r.end.character + 1,
	};
}

function isSyncedModelScheme(scheme: string): boolean {
	return scheme === 'file' || scheme === 'vscode-file';
}

function sanitizeForExtHost(text: string): string {
	return text
		.replace(/\u00a0/g, ' ')
		.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}



interface HandshakeMessage {
	type: 'sidex:handshake';
	connectionToken: string;
	reconnectionToken: string;
	extensionCount: number;
	extensions: { id: string; name: string }[];
}

type ProviderCapabilities = Record<string, unknown[][]>;

class TauriExtensionHostContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.tauriExtensionHost';

	private _ws: WebSocket | undefined;
	private _port: number | undefined;
	private _msgId = 0;
	private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private _reconnectAttempts = 0;
	private _pendingCallbacks = new Map<number, {
		resolve: (v: unknown) => void;
		reject: (e: Error) => void;
		timeoutHandle: ReturnType<typeof setTimeout>;
		type: string;
	}>();
	private _connected = false;
	private _handshakeSeen = false;
	private _providerRegistrations: IDisposable[] = [];
	private _documentsSyncInitialized = false;
	private _activeEditorSyncInitialized = false;
	private _editorTrackingInitialized = false;
	private _initialEditorsDeltaSent = false;
	private _trackedEditors = new Map<string, { editor: ICodeEditor; uri: string; listeners: IDisposable[] }>();
	private _activeTrackedEditorId: string | null = null;
	private _decorationTypes = new Map<string, IDisposable>();
	private _modelContentListeners = new Map<string, IDisposable>();
	private _tauriWatchListenerPromise: Promise<void> | undefined;
	private _completionColdStart = true;
	private _failureBurstLog = new Map<string, number>();

	private _bootstrapExtensions: IExtensionManifestSummary[] = [];
	private _statusBarItems = new Map<string, IStatusbarEntryAccessor>();
	private _webviewPanels = new Map<string, WebviewInput>();
	private _treeViews = new Map<string, TreeView>();
	private _registeredCommands = new Map<string, IDisposable>();
	private _webviewViewDisposables = new Map<string, IDisposable>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
		@IModelService private readonly modelService: IModelService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@IEditorService private readonly editorService: IEditorService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILanguageConfigurationService private readonly langConfigService: ILanguageConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@INotificationService private readonly notificationService: INotificationService,
		@IProgressService private readonly progressService: IProgressService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IDebugService private readonly debugService: IDebugService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IWebviewWorkbenchService private readonly webviewWorkbenchService: IWebviewWorkbenchService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IWebviewViewService private readonly webviewViewService: IWebviewViewService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
	) {
		super();
		this._init();
	}

	private async _init(): Promise<void> {
		if ((globalThis as any).__SIDEX_TAURI__ !== true) {
			return;
		}
		this._register(this.extensionManagementService.onDidInstallExtensions((results) => {
			for (const result of results) {
				if (result.local && !result.error) {
					this._hotLoadInstalledExtension(result);
				}
			}
		}));
		try {
			const bootstrap = await bootstrapExtensionPlatform();
			this._applyBootstrap(bootstrap);
			this._connect(bootstrap.transport.endpoint);
		} catch (error) {
			this.logService.warn(`[ExtHost] platform bootstrap failed ${(error as Error)?.message ?? String(error)}`);
		}
	}

	private async _hotLoadInstalledExtension(result: InstallExtensionResult): Promise<void> {
		const extId = result.identifier.id;
		try {
			const { invoke } = await import('@tauri-apps/api/core');

			const source = result.source;
			let installed: { id: string; path: string } | undefined;

			if (source && !URI.isUri(source) && (source as IGalleryExtension).assets?.download?.uri) {
				const downloadUrl = (source as IGalleryExtension).assets.download.uri;
				this.logService.info(`[ExtHost] Downloading extension ${extId} from gallery`);
				installed = await invoke<{ id: string; path: string }>('install_extension_from_url', { url: downloadUrl });
			} else if (result.local?.location.scheme === 'file') {
				installed = { id: extId, path: result.local.location.fsPath };
			}

			if (!installed?.path) {
				this.logService.warn(`[ExtHost] Cannot hot-load ${extId}: no filesystem path available`);
				return;
			}

			if (result.local?.manifest?.contributes) {
				const cmds: { command?: string }[] = (result.local.manifest.contributes as any).commands || [];
				for (const cmd of cmds) {
					if (cmd.command) {
						this._onCommandRegistered(cmd.command);
					}
				}
			}

			this.logService.info(`[ExtHost] Hot-loading extension ${extId} from ${installed.path}`);
			const loadResult = await this._request<{ extensionId?: string; alreadyActive?: boolean }>('loadExtension', { extensionPath: installed.path });
			if (loadResult?.extensionId && !loadResult.alreadyActive) {
				this._send({ id: this._nextId(), type: 'activateExtension', params: { extensionId: loadResult.extensionId } });
			}
		} catch (err: any) {
			this.logService.warn(`[ExtHost] Failed to hot-load ${extId}: ${err?.message ?? err}`);
		}
	}

	private _applyBootstrap(bootstrap: IExtensionPlatformBootstrap): void {
		this._bootstrapExtensions = bootstrap.extensions || [];

		const wasmExtensions = this._bootstrapExtensions.filter(e => e.kind === 'wasm');
		if (wasmExtensions.length > 0) {
			listen<number>('sidex-wasm-extensions-ready', () => {
				this.logService.info('[ExtHost] WASM extensions ready');
				this._syncDocumentsToWasm();
				setTimeout(() => this._registerWasmProviders(), 200);
			}).catch(() => {});
		}

		const workspaceFolders = this.workspaceContextService
			.getWorkspace()
			.folders
			.map(folder => folder.uri)
			.filter(uri => uri.scheme === 'file')
			.map(uri => uri.fsPath);
		if (workspaceFolders.length > 0) {
			wasmSyncWorkspaceFolders(workspaceFolders).catch(() => {});
		}

		this._syncDocumentsToWasm();
	}

	private _wasmDocSyncInitialized = false;

	private _syncDocumentsToWasm(): void {
		for (const model of this.modelService.getModels()) {
			if (isSyncedModelScheme(model.uri.scheme)) {
				wasmSyncDocument(model.uri.toString(), model.getLanguageId(), sanitizeForExtHost(model.getValue())).catch(() => {});
			}
		}

		if (this._wasmDocSyncInitialized) {
			return;
		}
		this._wasmDocSyncInitialized = true;

		this._register(this.modelService.onModelAdded(model => {
			if (isSyncedModelScheme(model.uri.scheme)) {
				wasmSyncDocument(model.uri.toString(), model.getLanguageId(), sanitizeForExtHost(model.getValue())).catch(() => {});
			}
		}));
		this._register(this.modelService.onModelRemoved(model => {
			if (isSyncedModelScheme(model.uri.scheme)) {
				wasmCloseDocument(model.uri.toString()).catch(() => {});
			}
		}));

		this._register(this.modelService.onModelAdded(model => {
			if (!isSyncedModelScheme(model.uri.scheme)) {
				return;
			}
			const key = `wasm-change-${model.uri.toString()}`;
			if (this._modelContentListeners.has(key)) {
				return;
			}
			const disposable = model.onDidChangeContent(() => {
				wasmSyncDocument(model.uri.toString(), model.getLanguageId(), sanitizeForExtHost(model.getValue())).catch(() => {});
			});
			this._modelContentListeners.set(key, disposable);
		}));
		this._register(this.modelService.onModelRemoved(model => {
			const key = `wasm-change-${model.uri.toString()}`;
			const listener = this._modelContentListeners.get(key);
			if (listener) {
				listener.dispose();
				this._modelContentListeners.delete(key);
			}
		}));
	}

	private _wasmProviderRegistrations: IDisposable[] = [];

	private _registerWasmProviders(): void {
		this._wasmProviderRegistrations.forEach(d => d.dispose());
		this._wasmProviderRegistrations = [];

		const wasmLanguages: LanguageSelector = [
			'css', 'scss', 'less',
			'html', 'htm',
			'json', 'jsonc',
			'typescript', 'typescriptreact', 'javascript', 'javascriptreact',
			'php',
			'markdown',
			'rust',
			'go',
			'c', 'cpp', 'objective-c', 'objective-cpp',
			'python',
		];

		this._wasmProviderRegistrations.push(
			this.languageFeatures.completionProvider.register(wasmLanguages, {
				_debugDisplayName: 'wasmExtHost',
				provideCompletionItems: async (model, position, _context, _token) => {
					try {
						const result = await wasmProvideCompletionAll(
							model.uri.toString(),
							model.getLanguageId(),
							model.getVersionId(),
							position.lineNumber - 1,
							position.column - 1,
						);
						if (!result?.items?.length) {
							return null;
						}

						const lineContent = model.getLineContent(position.lineNumber);
						const beforeCursor = lineContent.substring(0, position.column - 1);
						let wordStart = beforeCursor.length;
						while (wordStart > 0) {
							const ch = beforeCursor[wordStart - 1];
							if (/[\w\-$]/.test(ch)) {
								wordStart--;
							} else {
								break;
							}
						}
						const wordRange = {
							startLineNumber: position.lineNumber,
							startColumn: wordStart + 1,
							endLineNumber: position.lineNumber,
							endColumn: position.column,
						};

						const suggestions = this._normalizeCompletionItems(result.items);
						for (const s of suggestions) {
							if (!s.range) {
								s.range = wordRange;
							}
							if (!s.filterText) {
								s.filterText = s.label as string;
							}
						}
						return suggestions.length > 0 ? { suggestions, incomplete: result.isIncomplete } : null;
					} catch (e) {
						this.logService.warn(`[WASM] completion error: ${(e as Error)?.message}`);
						return null;
					}
				},
			})
		);

		this._wasmProviderRegistrations.push(
			this.languageFeatures.hoverProvider.register(wasmLanguages, {
				provideHover: async (model, position, _token) => {
					try {
						const result = await wasmProvideHoverAll(
							model.uri.toString(),
							model.getLanguageId(),
							model.getVersionId(),
							position.lineNumber - 1,
							position.column - 1,
						);
						if (!result?.contents?.length) {
							return null;
						}
						const contents = result.contents.map((c: any) => {
						let val = typeof c === 'string' ? c : String(c?.value ?? '');
						val = val.replace(/</g, '&lt;').replace(/>/g, '&gt;');
					return { value: val };
					});
					const lspRange = result.range ? toVscRange(result.range) : undefined;
						const wordRange = (() => {
							const word = model.getWordAtPosition(position);
							return word ? {
								startLineNumber: position.lineNumber,
								startColumn: word.startColumn,
								endLineNumber: position.lineNumber,
								endColumn: word.endColumn,
							} : undefined;
						})();
						return {
							contents,
							range: lspRange ?? wordRange,
						} satisfies Hover;
					} catch (e) {
						this.logService.warn(`[WASM] hover error: ${(e as Error)?.message}`);
						return null;
					}
				},
			})
		);

		this._wasmProviderRegistrations.push(
			this.languageFeatures.definitionProvider.register(wasmLanguages, {
				provideDefinition: async (model, position, _token) => {
					try {
						const result = await wasmProvideDefinitionAll(
							model.uri.toString(),
							model.getLanguageId(),
							model.getVersionId(),
							position.lineNumber - 1,
							position.column - 1,
						);
						if (!Array.isArray(result) || !result.length) {
							return null;
						}
						return result.map((l: any) => this._convertLocation(l));
					} catch {
						return null;
					}
				},
			})
		);

		this._wasmProviderRegistrations.push(
			this.languageFeatures.documentSymbolProvider.register(wasmLanguages, {
				provideDocumentSymbols: async (model, _token) => {
					try {
						const result = await wasmProvideDocumentSymbolsAll(
							model.uri.toString(),
							model.getLanguageId(),
							model.getVersionId(),
						);
						if (!Array.isArray(result) || !result.length) {
							return null;
						}
						return result.map((s: any) => this._convertDocumentSymbol(s));
					} catch {
						return null;
					}
				},
			})
		);

		this._wasmProviderRegistrations.push(
			this.languageFeatures.documentFormattingEditProvider.register(wasmLanguages, {
				provideDocumentFormattingEdits: async (model, options, _token) => {
					try {
						const result = await wasmProvideFormattingAll(
							model.uri.toString(),
							model.getLanguageId(),
							model.getVersionId(),
							options.tabSize,
							options.insertSpaces,
						);
						if (!Array.isArray(result) || !result.length) {
							return null;
						}
						return result.map((e: any) => ({ range: toVscRange(e.range), text: e.newText }));
					} catch {
						return null;
					}
				},
			})
		);

		this.logService.info(`[ExtHost] WASM providers registered for: ${(wasmLanguages as string[]).join(', ')}`);
	}

	private _connect(endpoint: string): void {
		try {
			const url = new URL(endpoint);
			this._port = Number(url.port) || undefined;
			const ws = new WebSocket(endpoint);
			this._ws = ws;

			ws.onopen = () => {
				this._connected = true;
				this._handshakeSeen = false;
				this._reconnectAttempts = 0;
				const workspaceFolders = this.workspaceContextService
					.getWorkspace()
					.folders
					.map(folder => folder.uri)
					.filter(uri => uri.scheme === 'file')
					.map(uri => uri.fsPath);
				this._send({ id: this._nextId(), type: 'initialize', params: { extensionPaths: [], workspaceFolders } });
				this._syncOpenDocuments();
				this._syncActiveEditor();
				this._startEditorTracking();
			};

			ws.onmessage = (event) => {
				try {
					this._handleMessage(JSON.parse(event.data as string));
				} catch { /* ignore malformed messages */ }
			};

			ws.onerror = () => { /* handled by onclose */ };

			ws.onclose = () => {
				this._ws = undefined;
				this._connected = false;
				this._handshakeSeen = false;
				this._capabilitiesQueried = false;
				this._rejectPending('connection closed');
				this._scheduleReconnect();
			};

			window.addEventListener('beforeunload', () => {
				if (this._ws?.readyState === WebSocket.OPEN) {
					this._ws.close(1000, 'page-unload');
					this._ws = undefined;
				}
			}, { once: true });
		} catch {
			this._scheduleReconnect();
		}
	}

	private _scheduleReconnect(): void {
		if (this._reconnectTimer || !this._port || this._reconnectAttempts >= 3) {
			return;
		}
		this._reconnectAttempts++;
		const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), 30000);
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = undefined;
			if (this._port && (!this._ws || this._ws.readyState === WebSocket.CLOSED)) {
				this._connect(`ws://127.0.0.1:${this._port}`);
			}
		}, delay);
	}

	override dispose(): void {
		clearTimeout(this._reconnectTimer);
		this._ws?.close();
		this._ws = undefined;
		this._connected = false;
		this._handshakeSeen = false;
		this._rejectPending('disposed');
		this._providerRegistrations.forEach(d => d.dispose());
		this._wasmProviderRegistrations.forEach(d => d.dispose());
		this._langConfigDisposables.forEach(d => d.dispose());
		this._statusBarItems.forEach(a => a.dispose());
		this._statusBarItems.clear();
		this._extTerminals.forEach(t => { try { t.dispose(); } catch {} });
		this._extTerminals.clear();
		this._activeProgressResolvers.forEach(r => r());
		this._activeProgressResolvers.clear();
		this._webviewPanels.forEach(p => { try { p.dispose(); } catch {} });
		this._webviewPanels.clear();
		this._webviewViewDisposables.forEach(d => { try { d.dispose(); } catch {} });
		this._webviewViewDisposables.clear();
		this._treeViews.forEach(t => { try { t.dispose(); } catch {} });
		this._treeViews.clear();
		this._modelContentListeners.forEach(d => d.dispose());
		this._modelContentListeners.clear();
		this._trackedEditors.forEach(entry => entry.listeners.forEach(l => l.dispose()));
		this._trackedEditors.clear();
		this._activeTrackedEditorId = null;
		this._decorationTypes.forEach(d => d.dispose());
		this._decorationTypes.clear();
		this._registeredCommands.forEach(d => d.dispose());
		this._registeredCommands.clear();
		this._typeOverrideInstalled = false;
		this._tauriWatchUnlisten?.();
		this._tauriWatchUnlisten = undefined;
		this._tauriWatchListenerPromise = undefined;
		clearTimeout(this._capabilityRetryTimer);
		this._capabilityRetryTimer = undefined;
		for (const [watcherId] of this._activeWatches) {
			this._onStopFileWatch(watcherId);
		}
		super.dispose();
	}

	private _nextId(): number {
		return ++this._msgId;
	}

	private _send(msg: Record<string, unknown>): void {
		if (this._ws?.readyState === WebSocket.OPEN) {
			this._ws.send(JSON.stringify(msg));
		}
	}

	private _rejectPending(reason: string): void {
		for (const [, cb] of this._pendingCallbacks) {
			clearTimeout(cb.timeoutHandle);
			cb.reject(new Error(`ExtHost request '${cb.type}' failed: ${reason}`));
		}
		this._pendingCallbacks.clear();
	}

	private _shouldLogFailureBurst(key: string, burstMs = 5000): boolean {
		const now = Date.now();
		const last = this._failureBurstLog.get(key) ?? 0;
		if (now - last < burstMs) {
			return false;
		}
		this._failureBurstLog.set(key, now);
		return true;
	}

	private _request<T = unknown>(
		type: string,
		params?: Record<string, unknown>,
		options?: { timeoutMs?: number; allowBeforeHandshake?: boolean }
	): Promise<T> {
		if (!this._connected || this._ws?.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error(`ExtHost request '${type}' skipped: connection not ready`));
		}
		if (!options?.allowBeforeHandshake && !this._handshakeSeen) {
			return Promise.reject(new Error(`ExtHost request '${type}' skipped: handshake not ready`));
		}
		const timeoutMs = options?.timeoutMs ?? 10000;
		return new Promise((resolve, reject) => {
			const id = this._nextId();
			const timeoutHandle = setTimeout(() => {
				if (this._pendingCallbacks.delete(id)) {
					reject(new Error(`ExtHost request '${type}' timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs);
			this._pendingCallbacks.set(id, {
				resolve: resolve as (v: unknown) => void,
				reject,
				timeoutHandle,
				type,
			});
			this._send({ id, type, params });
		});
	}

	private _extensionCount = 0;
	private _activatedCount = 0;
	private _capabilitiesQueried = false;
	private _capabilityRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private _capabilityRetryCount = 0;

	private _handleMessage(msg: any): void {
		if (msg.type === 'statusBarItemShow' || msg.type === 'statusBarItemUpdate') {
			this.logService.info(`[ExtHost] RECV ${msg.type}: id=${msg.id} text="${msg.text}"`);
		}
		if (msg.id !== undefined && this._pendingCallbacks.has(msg.id)) {
			const cb = this._pendingCallbacks.get(msg.id)!;
			this._pendingCallbacks.delete(msg.id);
			clearTimeout(cb.timeoutHandle);
			msg.error
				? cb.reject(new Error(String(msg.error)))
				: cb.resolve(msg.result);
			return;
		}

		switch (msg.type) {
			case 'sidex:handshake':
				this._onHandshake(msg as HandshakeMessage);
				break;
			case 'extensionActivated':
				this._activatedCount++;
				this._queryAndRegisterProviders();
				break;
			case 'commandRegistered':
				this._onCommandRegistered(msg.commandId);
				break;
			case 'executeWorkbenchCommand':
				this._onExecuteWorkbenchCommand(msg.reqId, msg.command, msg.args);
				break;
			case 'diagnosticsChanged':
				this._onDiagnosticsChanged(msg.uri, msg.diagnostics);
				break;
			case 'applyEdit':
				this._onApplyEdit(msg.edits);
				break;
			case 'showMessage':
				this.logService.info(`[ExtHost] ${msg.severity}: ${msg.message}`);
				break;
			case 'showTextDocument':
				this._onShowTextDocument(msg.uri, msg.options);
				break;
			case 'showQuickPick':
				this._onShowQuickPick(msg.id, msg.items, msg.options);
				break;
			case 'showInputBox':
				this._onShowInputBox(msg.id, msg.options);
				break;
			case 'showMessageRequest':
				this._onShowMessageRequest(msg.id, msg.severity, msg.message, msg.items);
				break;
			case 'languageConfigurationChanged':
				this._onLanguageConfigurationChanged(msg.language, msg.configuration);
				break;
			case 'startFileWatch':
				this._onStartFileWatch(msg.watcherId, msg.paths, msg.pattern, msg.recursive);
				break;
			case 'stopFileWatch':
				this._onStopFileWatch(msg.watcherId);
				break;
			case 'statusBarItemShow':
				this._onStatusBarItemShow(msg);
				break;
			case 'statusBarItemUpdate':
				this._onStatusBarItemUpdate(msg);
				break;
			case 'statusBarItemHide':
				this._onStatusBarItemHide(msg.id);
				break;
			case 'statusBarItemRemove':
				this._onStatusBarItemRemove(msg.id);
				break;
			case 'showOpenDialog':
				this._onShowOpenDialog(msg.id, msg.options);
				break;
			case 'showSaveDialog':
				this._onShowSaveDialog(msg.id, msg.options);
				break;
			case 'progressStart':
				this._onProgressStart(msg.location, msg.title);
				break;
			case 'progressEnd':
				this._onProgressEnd(msg.location, msg.title);
				break;
			case 'progress':
				this._onProgress(msg);
				break;
			case 'createTerminal':
				this._onCreateTerminal(msg);
				break;
			case 'terminalSendText':
				this._onTerminalSendText(msg.terminalId, msg.text, msg.addNewLine);
				break;
			case 'terminalShow':
				this._onTerminalShow(msg.terminalId);
				break;
			case 'terminalDispose':
				this._onTerminalDispose(msg.terminalId);
				break;
			case 'createWebviewPanel':
				this._onCreateWebviewPanel(msg);
				break;
			case 'webviewHtmlUpdate':
				this._onWebviewHtmlUpdate(msg.panelId, msg.html);
				break;
			case 'webviewPanelUpdate':
				this._onWebviewPanelUpdate(msg.panelId, msg.title);
				break;
			case 'webviewPostMessage':
				this._onWebviewPostMessage(msg.panelId, msg.message);
				break;
			case 'webviewViewHtmlUpdate':
				this._onWebviewViewHtmlUpdate(msg.webviewHandle, msg.html);
				break;
			case 'webviewViewPostMessage':
				this._onWebviewViewPostMessage(msg.webviewHandle, msg.message);
				break;
			case 'webviewViewShow':
				this.logService.trace(`[ExtHost] webviewViewShow: ${msg.webviewHandle}`);
				break;
			case 'webviewPanelReveal':
				this._onWebviewPanelReveal(msg.panelId, msg.viewColumn, msg.preserveFocus);
				break;
			case 'webviewPanelIcon':
				this._onWebviewPanelIcon(msg.panelId, msg.light, msg.dark);
				break;
			case 'webviewPanelDispose':
				this._onWebviewPanelDispose(msg.panelId);
				break;
			case 'registerTreeDataProvider':
				this._onRegisterTreeDataProvider(msg.viewId);
				break;
			case 'createTreeView':
				this._onCreateTreeView(msg.viewId, msg.canSelectMany);
				break;
			case 'treeViewUpdate':
				this._onTreeViewUpdate(msg.viewId, msg);
				break;
			case 'treeViewReveal':
				this.logService.trace(`[ExtHost] treeViewReveal: ${msg.viewId}`);
				break;
			case 'startDebugging':
				this._onStartDebugging(msg.folder, msg.config);
				break;
			case 'stopDebugging':
				this._onStopDebugging(msg.sessionId);
				break;
			case 'debugConsoleAppend':
				this.logService.trace(`[ExtHost] debugConsole: ${msg.value}`);
				break;
			case 'executeTask':
				this.logService.info(`[ExtHost] executeTask: ${msg.name} (${msg.source})`);
				break;
			case 'terminateTask':
				this.logService.info(`[ExtHost] terminateTask: ${msg.id}`);
				break;
			case 'openExternal':
				this._onOpenExternal(msg.url);
				break;
			case 'registerUriHandler':
				this.logService.info('[ExtHost] registerUriHandler');
				break;
			case 'registerWebviewViewProvider':
				this._onRegisterWebviewViewProvider(msg.viewId);
				break;
			case 'registerCustomEditorProvider':
				this.logService.info(`[ExtHost] registerCustomEditorProvider: ${msg.viewType}`);
				break;
			case 'registerTaskProvider':
				this.logService.info(`[ExtHost] registerTaskProvider: ${msg.taskType}`);
				break;
			case 'scmSourceControlCreated':
				this.logService.info(`[ExtHost] scmSourceControlCreated: ${msg.id}`);
				break;
			case 'registerChatParticipant':
				this.logService.info(`[ExtHost] registerChatParticipant: ${msg.id}`);
				break;
			case 'registerLanguageModelTool':
				this.logService.info(`[ExtHost] registerLanguageModelTool: ${msg.name}`);
				break;
			case 'registerAuthenticationProvider':
				this.logService.info(`[ExtHost] registerAuthenticationProvider: ${msg.id}`);
				break;
			case 'createCommentController':
				this.logService.info(`[ExtHost] createCommentController: ${msg.id}`);
				break;
			case 'createNotebookController':
				this.logService.info(`[ExtHost] createNotebookController: ${msg.id}`);
				break;
			case 'trySetSelections':
				this._onTrySetSelections(msg.editorId, msg.selections);
				break;
			case 'trySetOptions':
				this._onTrySetOptions(msg.editorId, msg.options);
				break;
			case 'tryRevealRange':
				this._onTryRevealRange(msg.editorId, msg.range, msg.revealType);
				break;
			case 'trySetDecorations':
				this._onTrySetDecorations(msg.editorId, msg.key, msg.ranges);
				break;
			case 'registerDecorationType':
				this._onRegisterDecorationType(msg.key, msg.options);
				break;
			case 'removeDecorationType':
				this._onRemoveDecorationType(msg.key);
				break;
		}
	}

	private _onExecuteWorkbenchCommand(reqId: number, command: string, args: any[]): void {
		this.commandService.executeCommand(command, ...(args || [])).then(
			(result) => {
				const editorState = this._getActiveEditorState();
				this._send({ id: this._nextId(), type: 'workbenchCommandResult', params: { reqId, result: result ?? null, editorState } });
			},
			(err: unknown) => {
				this._send({ id: this._nextId(), type: 'workbenchCommandResult', params: { reqId, error: err instanceof Error ? err.message : String(err) } });
			}
		);
	}

	private _getActiveEditorState(): { editorId: string; selections: any[] } | null {
		if (!this._activeTrackedEditorId) {return null;}
		const entry = this._trackedEditors.get(this._activeTrackedEditorId);
		if (!entry) {return null;}
		const allSelections = entry.editor.getSelections() || [];
		return {
			editorId: this._activeTrackedEditorId,
			selections: allSelections.map((s: any) => ({
				anchor: { line: s.selectionStartLineNumber - 1, character: s.selectionStartColumn - 1 },
				active: { line: s.positionLineNumber - 1, character: s.positionColumn - 1 },
			})),
		};
	}

	private _onCommandRegistered(commandId: string): void {
		if (!commandId || this._registeredCommands.has(commandId)) {
			return;
		}
		if (commandId === 'type') {
			this._installTypeCommandOverride();
			return;
		}
		if (commandId === 'default:type') {
			return;
		}
		if (commandId.startsWith('workbench.') || commandId.startsWith('editor.') || commandId.startsWith('_')) {
			return;
		}
		if (CommandsRegistry.getCommand(commandId)) {
			return;
		}
		const disposable = CommandsRegistry.registerCommand(commandId, (_accessor, ...args: any[]) => {
			this.logService.info(`[ExtHost] CMD INVOKE: ${commandId}`);
			return this._request('executeCommand', { command: commandId, args: args.map(a => {
				try { return JSON.parse(JSON.stringify(a)); } catch { return String(a); }
			}) });
		});
		this._registeredCommands.set(commandId, disposable);
	}

	private _typeOverrideInstalled = false;
	private _installTypeCommandOverride(): void {
		if (this._typeOverrideInstalled) {
			return;
		}
		this._typeOverrideInstalled = true;
		this.logService.info('[ExtHost] installing type command override (extension registered type handler)');
		const disposable = CommandsRegistry.registerCommand('type', (_accessor, args: { text: string }) => {
			if (!this._connected) {
				return this.commandService.executeCommand('default:type', args);
			}
			return this._request('executeCommand', {
				command: 'type',
				args: [args],
			}, { timeoutMs: 2000 }).catch(() => {
				return this.commandService.executeCommand('default:type', args);
			});
		});
		this._registeredCommands.set('type', disposable);
	}

	private _findTrackedEditor(editorId: string): ICodeEditor | undefined {
		return this._trackedEditors.get(editorId)?.editor;
	}

	private _onTrySetSelections(editorId: string, selections: any[]): void {
		const editor = this._findTrackedEditor(editorId);
		if (!editor || !selections?.length) {return;}
		const editorSelections = selections.map((s: any) => ({
			selectionStartLineNumber: (s.anchor?.line ?? 0) + 1,
			selectionStartColumn: (s.anchor?.character ?? 0) + 1,
			positionLineNumber: (s.active?.line ?? 0) + 1,
			positionColumn: (s.active?.character ?? 0) + 1,
		}));
		editor.setSelections(editorSelections);
	}

	private _onTrySetOptions(editorId: string, options: any): void {
		const editor = this._findTrackedEditor(editorId);
		if (!editor || !options) {return;}
		const opts: Record<string, unknown> = {};
		if (options.cursorStyle !== undefined) {opts.cursorStyle = options.cursorStyle;}
		if (options.lineNumbers !== undefined) {
			opts.lineNumbers = options.lineNumbers === 2 ? 'relative' : options.lineNumbers === 1 ? 'on' : 'off';
		}
		if (Object.keys(opts).length) {(editor as any).updateOptions(opts);}
		if (options.tabSize !== undefined || options.insertSpaces !== undefined) {
			const model = editor.getModel();
			if (model) {model.updateOptions({ tabSize: options.tabSize, insertSpaces: options.insertSpaces });}
		}
	}

	private _onTryRevealRange(editorId: string, range: any, revealType: number): void {
		const editor = this._findTrackedEditor(editorId);
		if (!editor || !range) {return;}
		const monacoRange = new Range(
			(range.start?.line ?? 0) + 1, (range.start?.character ?? 0) + 1,
			(range.end?.line ?? 0) + 1, (range.end?.character ?? 0) + 1,
		);
		switch (revealType) {
			case 1: editor.revealRangeInCenter(monacoRange); break;
			case 2: editor.revealRangeInCenterIfOutsideViewport(monacoRange); break;
			case 3: editor.revealRangeAtTop(monacoRange); break;
			default: editor.revealRange(monacoRange); break;
		}
	}

	private _onTrySetDecorations(editorId: string, key: string, ranges: any[]): void {
		const editor = this._findTrackedEditor(editorId);
		if (!editor || !key) {return;}
		const decorations = (ranges || []).map((r: any) => {
			const range = r.range || r;
			return {
				range: new Range(
					(range.start?.line ?? 0) + 1, (range.start?.character ?? 0) + 1,
					(range.end?.line ?? 0) + 1, (range.end?.character ?? 0) + 1,
				),
				options: { className: key },
			};
		});
		(editor as any).setDecorationsByType('sidex-exthost', key, decorations);
	}

	private _onRegisterDecorationType(key: string, options: any): void {
		if (!key || this._decorationTypes.has(key)) {return;}
		try {
			this.codeEditorService.registerDecorationType('sidex-exthost', key, options || {});
			this._decorationTypes.set(key, { dispose: () => this.codeEditorService.removeDecorationType(key) });
		} catch (e) {
			this.logService.warn(`[ExtHost] registerDecorationType failed for ${key}:`, e);
		}
	}

	private _onRemoveDecorationType(key: string): void {
		const entry = this._decorationTypes.get(key);
		if (entry) {
			entry.dispose();
			this._decorationTypes.delete(key);
		}
	}

	private _onRegisterWebviewViewProvider(viewId: string): void {
		if (this._webviewViewDisposables.has(viewId)) {
			return;
		}
		this.logService.info(`[ExtHost] registerWebviewViewProvider: ${viewId}`);

		const webviewHandles = new Map<string, { webview: any; listeners: IDisposable[] }>();

		const registration = this.webviewViewService.register(viewId, {
			resolve: async (webviewView, _cancellation) => {
				const webviewHandle = `wvv-${viewId}-${++this._msgId}`;
				const listeners: IDisposable[] = [];

				const rootUri = URI.from({ scheme: 'file', path: '/' });
				webviewView.webview.localResourcesRoot = [rootUri];
				webviewView.webview.contentOptions = {
					...webviewView.webview.contentOptions,
					allowScripts: true,
					localResourceRoots: [rootUri],
				};

				listeners.push(webviewView.webview.onMessage(e => {
					this._send({
						id: this._nextId(),
						type: 'webviewViewMessage',
						params: { webviewHandle, message: e.message },
					});
				}));

				webviewHandles.set(webviewHandle, { webview: webviewView.webview, listeners });

				await this._request('resolveWebviewView', {
					viewId,
					webviewHandle,
					title: webviewView.title,
					state: undefined,
				}, { timeoutMs: 30000 });
			},
		});

		this._webviewViewDisposables.set(viewId, {
			dispose: () => {
				registration.dispose();
				for (const [, entry] of webviewHandles) {
					for (const l of entry.listeners) { l.dispose(); }
				}
				webviewHandles.clear();
			},
		});

		(this as any)[`_wvvHandles_${viewId}`] = webviewHandles;
	}

	private _onWebviewViewHtmlUpdate(webviewHandle: string, html: string): void {
		const handles = this._findWebviewHandles(webviewHandle);
		if (handles) {
			handles.webview.setHtml(html);
		} else {
			this.logService.warn(`[ExtHost] webviewViewHtmlUpdate: handle ${webviewHandle} not found`);
		}
	}

	private _onWebviewViewPostMessage(webviewHandle: string, message: any): void {
		const handles = this._findWebviewHandles(webviewHandle);
		if (handles) {
			this.logService.info(`[ExtHost] webviewViewPostMessage → ${webviewHandle}: ${JSON.stringify(message).substring(0, 200)}`);
			handles.webview.postMessage(message);
		} else {
			this.logService.warn(`[ExtHost] webviewViewPostMessage: handle ${webviewHandle} not found`);
		}
	}

	private _onWebviewPostMessage(panelId: string, message: any): void {
		const panel = this._webviewPanels.get(panelId);
		if (panel) {
			panel.webview.postMessage(message);
		}
	}

	private _findWebviewHandles(webviewHandle: string): { webview: any; listeners: IDisposable[] } | undefined {
		for (const [viewId] of this._webviewViewDisposables) {
			const map = (this as any)[`_wvvHandles_${viewId}`] as Map<string, { webview: any; listeners: IDisposable[] }> | undefined;
			if (map?.has(webviewHandle)) {
				return map.get(webviewHandle);
			}
		}
		const viewIdMatch = webviewHandle.match(/^wvv-(.+)-\d+$/);
		if (viewIdMatch) {
			const viewId = viewIdMatch[1];
			const map = (this as any)[`_wvvHandles_${viewId}`] as Map<string, { webview: any; listeners: IDisposable[] }> | undefined;
			if (map && map.size > 0) {
				return [...map.values()].pop();
			}
		}
		return undefined;
	}

	private _onHandshake(msg: HandshakeMessage): void {
		this._handshakeSeen = true;
		this._extensionCount = msg.extensionCount;
		this._activatedCount = 0;
		this._capabilitiesQueried = false;
		this._completionColdStart = true;
		this._capabilityRetryCount = 0;
		clearTimeout(this._capabilityRetryTimer);
		this._capabilityRetryTimer = undefined;
		this.logService.info(`[ExtHost] Connected — ${msg.extensionCount} extensions`);

		this._request('resetPanels', {}, { timeoutMs: 3000, allowBeforeHandshake: true }).catch(() => {});

		for (const ext of msg.extensions) {
			this._send({ id: this._nextId(), type: 'activateExtension', params: { extensionId: ext.id } });
		}

		this._syncExtensionState();

		setTimeout(() => {
			if (!this._capabilitiesQueried) {
				this._queryAndRegisterProviders();
			}
		}, 3000);
	}

	private _syncExtensionState(): void {
		this._request<{
			commands: string[];
			webviewViewProviders: string[];
			customEditorProviders: string[];
		}>('getExtensionState', {}, { timeoutMs: 5000, allowBeforeHandshake: true }).then(
			(state) => {
				if (!state) { return; }
				for (const cmd of state.commands) {
					this._onCommandRegistered(cmd);
				}
				for (const viewId of state.webviewViewProviders) {
					this._onRegisterWebviewViewProvider(viewId);
				}
				const kiloCmds = state.commands.filter(c => c.startsWith('kilo-code'));
				this.logService.info(`[ExtHost] Synced state: ${state.commands.length} commands (${kiloCmds.length} kilo), ${state.webviewViewProviders.length} webview views`);
				if (kiloCmds.length > 0) {
					this.logService.info(`[ExtHost] Kilo commands: ${kiloCmds.join(', ')}`);
				}
			},
			() => {}
		);
	}

	private async _queryAndRegisterProviders(): Promise<void> {
		try {
			const caps = await this._request<ProviderCapabilities>('getProviderCapabilities');
			if (!caps || Object.keys(caps).length === 0) {
				if (!this._capabilitiesQueried && this._connected && this._capabilityRetryCount < 5) {
					this._capabilityRetryCount++;
					clearTimeout(this._capabilityRetryTimer);
					this._capabilityRetryTimer = setTimeout(() => {
						this._capabilityRetryTimer = undefined;
						if (this._connected && !this._capabilitiesQueried) {
							this._queryAndRegisterProviders();
						}
					}, 1000);
				}
				return;
			}
			this._capabilitiesQueried = true;
			this._capabilityRetryCount = 0;
			clearTimeout(this._capabilityRetryTimer);
			this._capabilityRetryTimer = undefined;
			this._registerProviders(caps);
		} catch (e) {
			this.logService.warn('[ExtHost] Could not get provider capabilities:', e);
		}
	}

	private _registerProviders(caps: ProviderCapabilities): void {
		this._providerRegistrations.forEach(d => d.dispose());
		this._providerRegistrations = [];

		const selectors = (selectorList: unknown[][]): LanguageSelector => {
			const all: string[] = [];
			for (const s of selectorList.flat()) {
				if (typeof s === 'string') {
					all.push(s);
				} else if (s && typeof (s as any).language === 'string') {
					all.push((s as any).language);
				}
			}
			const unique = [...new Set(all)];
			return unique.length > 0 ? unique as LanguageSelector : '*';
		};

		// SideX: New capability format — `{selector, extensionId, displayName}[]`.
		// Old format was just `selector[][]` (arrays of selectors). Normalize.
		const normalizeProviders = (raw: any): Array<{ selector: unknown[]; extensionId?: string; displayName?: string }> => {
			if (!Array.isArray(raw)) { return []; }
			return raw.map((entry: any) => {
				if (entry && typeof entry === 'object' && 'selector' in entry) {
					return { selector: entry.selector, extensionId: entry.extensionId, displayName: entry.displayName };
				}
				// Legacy: the entry IS the selector array
				return { selector: entry };
			});
		};

		if (caps.completion) {
			this._providerRegistrations.push(
				this.languageFeatures.completionProvider.register(selectors(caps.completion), {
					_debugDisplayName: 'tauriExtHost',
					provideCompletionItems: (model, position, context, _token) =>
						this._provideCompletionItems(model, position, context),
				})
			);
		}

		if (caps.hover) {
			this._providerRegistrations.push(
				this.languageFeatures.hoverProvider.register(selectors(caps.hover), {
					provideHover: (model, position, _token) =>
						this._provideHover(model, position),
				})
			);
		}

		if (caps.definition) {
			this._providerRegistrations.push(
				this.languageFeatures.definitionProvider.register(selectors(caps.definition), {
					provideDefinition: (model, position, _token) =>
						this._provideDefinition(model, position),
				})
			);
		}

		if (caps.typeDefinition) {
			this._providerRegistrations.push(
				this.languageFeatures.typeDefinitionProvider.register(selectors(caps.typeDefinition), {
					provideTypeDefinition: (model, position, _token) =>
						this._provideGenericLocations('provideTypeDefinition', model, position),
				})
			);
		}

		if (caps.implementation) {
			this._providerRegistrations.push(
				this.languageFeatures.implementationProvider.register(selectors(caps.implementation), {
					provideImplementation: (model, position, _token) =>
						this._provideGenericLocations('provideImplementation', model, position),
				})
			);
		}

		if (caps.declaration) {
			this._providerRegistrations.push(
				this.languageFeatures.declarationProvider.register(selectors(caps.declaration), {
					provideDeclaration: (model, position, _token) =>
						this._provideGenericLocations('provideDeclaration', model, position),
				})
			);
		}

		if (caps.references) {
			this._providerRegistrations.push(
				this.languageFeatures.referenceProvider.register(selectors(caps.references), {
					provideReferences: (model, position, _context, _token) =>
						this._provideReferences(model, position),
				})
			);
		}

		if (caps.documentSymbol) {
			this._providerRegistrations.push(
				this.languageFeatures.documentSymbolProvider.register(selectors(caps.documentSymbol), {
					provideDocumentSymbols: (model, _token) =>
						this._provideDocumentSymbols(model),
				})
			);
		}

		if (caps.codeAction) {
			this._providerRegistrations.push(
				this.languageFeatures.codeActionProvider.register(selectors(caps.codeAction), {
					provideCodeActions: (model, rangeOrSelection, context, _token) =>
						this._provideCodeActions(model, rangeOrSelection, context),
				})
			);
		}

		if (caps.codeLens) {
			this._providerRegistrations.push(
				this.languageFeatures.codeLensProvider.register(selectors(caps.codeLens), {
					provideCodeLenses: (model, _token) =>
						this._provideCodeLenses(model),
				})
			);
		}

		if (caps.formatting) {
			const formatters = normalizeProviders(caps.formatting);
			for (const f of formatters) {
				this._providerRegistrations.push(
					this.languageFeatures.documentFormattingEditProvider.register(selectors([f.selector as unknown[]]), {
						extensionId: f.extensionId ? new ExtensionIdentifier(f.extensionId) : undefined,
						displayName: f.displayName,
						provideDocumentFormattingEdits: (model, options, _token) =>
							this._provideFormatting(model, options),
					} as any)
				);
			}
		}

		if (caps.rangeFormatting) {
			const formatters = normalizeProviders(caps.rangeFormatting);
			for (const f of formatters) {
				this._providerRegistrations.push(
					this.languageFeatures.documentRangeFormattingEditProvider.register(selectors([f.selector as unknown[]]), {
						extensionId: f.extensionId ? new ExtensionIdentifier(f.extensionId) : undefined,
						displayName: f.displayName,
						provideDocumentRangeFormattingEdits: (model, range, options, _token) =>
							this._provideRangeFormatting(model, range, options),
					} as any)
				);
			}
		}

		if (caps.signatureHelp) {
			this._providerRegistrations.push(
				this.languageFeatures.signatureHelpProvider.register(selectors(caps.signatureHelp), {
					signatureHelpTriggerCharacters: ['(', ','],
					signatureHelpRetriggerCharacters: [','],
					provideSignatureHelp: (model, position, _token, context) =>
						this._provideSignatureHelp(model, position, context),
				})
			);
		}

		if (caps.documentHighlight) {
			this._providerRegistrations.push(
				this.languageFeatures.documentHighlightProvider.register(selectors(caps.documentHighlight), {
					provideDocumentHighlights: (model, position, _token) =>
						this._provideDocumentHighlights(model, position),
				})
			);
		}

		if (caps.rename) {
			this._providerRegistrations.push(
				this.languageFeatures.renameProvider.register(selectors(caps.rename), {
					provideRenameEdits: (model, position, newName, _token) =>
						this._provideRenameEdits(model, position, newName),
					resolveRenameLocation: (model, position, _token) =>
						this._resolveRenameLocation(model, position),
				})
			);
		}

		if (caps.documentLink) {
			this._providerRegistrations.push(
				this.languageFeatures.linkProvider.register(selectors(caps.documentLink), {
					provideLinks: (model, _token) =>
						this._provideDocumentLinks(model),
				})
			);
		}

		if (caps.foldingRange) {
			this._providerRegistrations.push(
				this.languageFeatures.foldingRangeProvider.register(selectors(caps.foldingRange), {
					provideFoldingRanges: (model, _context, _token) =>
						this._provideFoldingRanges(model),
				})
			);
		}

		if (caps.inlayHint) {
			this._providerRegistrations.push(
				this.languageFeatures.inlayHintsProvider.register(selectors(caps.inlayHint), {
					provideInlayHints: (model, range, _token) =>
						this._provideInlayHints(model, range),
				})
			);
		}

		if (caps.selectionRange) {
			this._providerRegistrations.push(
				this.languageFeatures.selectionRangeProvider.register(selectors(caps.selectionRange), {
					provideSelectionRanges: (model, positions, _token) =>
						this._provideSelectionRanges(model, positions),
				})
			);
		}

		if (caps.semanticTokens) {
			this._providerRegistrations.push(
				this.languageFeatures.documentSemanticTokensProvider.register(selectors(caps.semanticTokens), {
					getLegend: () => this._semanticTokensLegend,
					provideDocumentSemanticTokens: (model, _lastResultId, _token) =>
						this._provideSemanticTokens(model),
					releaseDocumentSemanticTokens: () => {},
				})
			);
		}

		if (caps.color) {
			this._providerRegistrations.push(
				this.languageFeatures.colorProvider.register(selectors(caps.color), {
					provideDocumentColors: (model, _token) =>
						this._provideDocumentColors(model),
					provideColorPresentations: (_model, _colorInfo, _token) =>
						Promise.resolve([]),
				})
			);
		}

		this.logService.info(`[ExtHost] Registered providers for: ${Object.keys(caps).join(', ')}`);
	}


	private async _provideCompletionItems(
		model: ITextModel,
		position: Position,
		context: CompletionContext,
	): Promise<CompletionList | null> {
		const startedAt = Date.now();
		const languageId = model.getLanguageId();
		const uri = model.uri.toString();
		const uriScheme = model.uri.scheme;
		const pos = `${position.lineNumber}:${position.column}`;
		if (!this._connected || !this._handshakeSeen) {
			if (this._shouldLogFailureBurst('completion-skipped-not-ready')) {
				this.logService.warn(`[ExtHost] completion skipped ${JSON.stringify({ languageId, uriScheme, uri, pos, reason: 'host-not-ready' })}`);
			}
			return null;
		}

		try {
			const timeoutMs = this._completionColdStart ? 20000 : 10000;
			const result = await this._request<{ items: any[] } | null>('provideCompletionItems', {
				...modelToParams(model, position),
				triggerCharacter: context.triggerCharacter,
				triggerKind: context.triggerKind,
			}, { timeoutMs });
			let suggestions = this._normalizeCompletionItems(result?.items ?? []);
			if (suggestions.length === 0) {
				const fallbackPositions = this._completionFallbackPositions(model, position);
				for (const fallbackPos of fallbackPositions) {
					const fallbackResult = await this._request<{ items: any[] } | null>('provideCompletionItems', {
						...modelToParams(model, fallbackPos),
						triggerCharacter: undefined,
						triggerKind: context.triggerKind,
					}, { timeoutMs: Math.min(timeoutMs, 4000) });
					suggestions = this._normalizeCompletionItems(fallbackResult?.items ?? []);
					if (suggestions.length > 0) {
						break;
					}
				}
			}
			if (suggestions.length === 0) {
				suggestions = this._fallbackCompletions(model, position);
			}
			this._completionColdStart = false;
			if (!suggestions.length) {
				return null;
			}
			return {
				suggestions,
				incomplete: false,
			};
		} catch (error) {
			const latencyMs = Date.now() - startedAt;
			if (this._shouldLogFailureBurst('completion-error')) {
				this.logService.warn(`[ExtHost] completion error ${JSON.stringify({
					languageId,
					uriScheme,
					pos,
					latencyMs,
					error: error instanceof Error ? error.message : String(error),
				})}`);
			}
			return null;
		}
	}

	private _completionFallbackPositions(model: ITextModel, position: Position): Position[] {
		const positions: Position[] = [];
		const seen = new Set<string>();
		const push = (lineNumber: number, column: number) => {
			if (lineNumber < 1 || lineNumber > model.getLineCount()) {
				return;
			}
			const maxCol = model.getLineMaxColumn(lineNumber);
			const clampedCol = Math.max(1, Math.min(column, maxCol));
			const key = `${lineNumber}:${clampedCol}`;
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			positions.push({ lineNumber, column: clampedCol } as Position);
		};

		const wordUntil = model.getWordUntilPosition(position);
		if (wordUntil && wordUntil.startColumn > 0 && wordUntil.startColumn < position.column) {
			push(position.lineNumber, wordUntil.startColumn);
		}
		if (position.column > 2) {
			push(position.lineNumber, position.column - 1);
		}
		const lineContent = model.getLineContent(position.lineNumber);
		const trimmed = lineContent.trim();
		if (trimmed.includes('{') && !trimmed.includes(':')) {
			const firstSelectorChar = lineContent.search(/\S/);
			if (firstSelectorChar >= 0) {
				push(position.lineNumber, firstSelectorChar + 2);
			}
			const braceIndex = lineContent.indexOf('{');
			if (braceIndex > 0) {
				push(position.lineNumber, braceIndex + 1);
			}
		}
		return positions;
	}

	private _fallbackCompletions(model: ITextModel, position: Position): CompletionItem[] {
		const languageId = model.getLanguageId();
		const word = model.getWordUntilPosition(position);
		const prefix = (word?.word ?? '').toLowerCase();
		if (prefix.length === 0) {
			return [];
		}

		const seen = new Set<string>();
		const out: CompletionItem[] = [];
		const push = (label: string, kind = CompletionItemKind.Text) => {
			if (!label || label.toLowerCase() === prefix || seen.has(label)) {
				return;
			}
			if (!label.toLowerCase().startsWith(prefix)) {
				return;
			}
			seen.add(label);
			out.push({
				label,
				kind,
				insertText: label,
				range: {
					startLineNumber: position.lineNumber,
					startColumn: word.startColumn,
					endLineNumber: position.lineNumber,
					endColumn: word.endColumn,
				},
			} as CompletionItem);
		};

		const text = sanitizeForExtHost(model.getValue());
		const re = /[A-Za-z_][$\w-]{2,}/g;
		let m: RegExpExecArray | null = null;
		while ((m = re.exec(text)) !== null) {
			push(m[0], CompletionItemKind.Text);
			if (out.length >= 300) {
				break;
			}
		}

		if (languageId === 'typescript' || languageId === 'typescriptreact' || languageId === 'javascript' || languageId === 'javascriptreact') {
			for (const kw of ['const', 'let', 'var', 'function', 'return', 'import', 'from', 'export', 'default', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'class', 'extends', 'implements', 'interface', 'type', 'async', 'await', 'new', 'this', 'super']) {
				push(kw, CompletionItemKind.Keyword);
			}
		}

		if (out.length > 0 && this._shouldLogFailureBurst('completion-local-fallback', 3000)) {
			this.logService.info(`[ExtHost] completion local-fallback ${JSON.stringify({ languageId, prefix, count: out.length })}`);
		}
		return out;
	}

	private _escapeForRegExp(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	private _fallbackHover(model: ITextModel, position: Position): Hover | null {
		const word = model.getWordAtPosition(position);
		if (!word?.word) {
			return null;
		}

		const escaped = this._escapeForRegExp(word.word);
		const occurrenceCount = (sanitizeForExtHost(model.getValue()).match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length;
		const label = occurrenceCount === 1 ? 'occurrence' : 'occurrences';
		const hover: Hover = {
			contents: [
				{ value: `\`${word.word}\`` },
				{ value: `${occurrenceCount} ${label} in file` },
			],
			range: {
				startLineNumber: position.lineNumber,
				startColumn: word.startColumn,
				endLineNumber: position.lineNumber,
				endColumn: word.endColumn,
			},
		};

		if (this._shouldLogFailureBurst('hover-local-fallback', 3000)) {
			this.logService.info(`[ExtHost] hover local-fallback ${JSON.stringify({ languageId: model.getLanguageId(), word: word.word })}`);
		}
		return hover;
	}

	private _fallbackDefinition(model: ITextModel, position: Position): Location | Location[] | null {
		const word = model.getWordAtPosition(position);
		if (!word?.word) {
			return null;
		}

		const escaped = this._escapeForRegExp(word.word);
		const declarationPatterns = [
			new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`),
			new RegExp(`\\bfunction\\s+${escaped}\\b`),
			new RegExp(`\\bclass\\s+${escaped}\\b`),
			new RegExp(`\\binterface\\s+${escaped}\\b`),
			new RegExp(`\\btype\\s+${escaped}\\b`),
			new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?${escaped}\\s*[:=]\\s*`),
		];

		for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber++) {
			const line = model.getLineContent(lineNumber);
			for (const pattern of declarationPatterns) {
				const match = pattern.exec(line);
				if (!match) {
					continue;
				}

				const symbolIndex = line.indexOf(word.word, match.index);
				if (symbolIndex < 0) {
					continue;
				}

				const location: Location = {
					uri: model.uri,
					range: new Range(lineNumber, symbolIndex + 1, lineNumber, symbolIndex + 1 + word.word.length),
				};
				if (this._shouldLogFailureBurst('definition-local-fallback', 3000)) {
					this.logService.info(`[ExtHost] definition local-fallback ${JSON.stringify({ languageId: model.getLanguageId(), word: word.word, lineNumber })}`);
				}
				return location;
			}
		}

		return null;
	}

	private async _provideHover(model: ITextModel, position: Position): Promise<Hover | null> {
		try {
			const result = await this._request<{ contents: any[]; range?: any } | null>('provideHover', modelToParams(model, position));
			if (!result?.contents?.length) {
				return this._fallbackHover(model, position);
			}
			return {
				contents: result.contents.map(c => ({ value: typeof c === 'string' ? c : String(c?.value ?? '') })),
				range: result.range ? toVscRange(result.range) : undefined,
			};
		} catch (error) {
			if (this._shouldLogFailureBurst('hover-error', 3000)) {
				this.logService.warn(`[ExtHost] hover error ${(error as Error)?.message ?? String(error)}`);
			}
			return this._fallbackHover(model, position);
		}
	}

	private async _provideDefinition(model: ITextModel, position: Position): Promise<Location | Location[] | null> {
		try {
			const result = await this._request<any>('provideDefinition', modelToParams(model, position));
			return result ? this._convertLocations(result) : this._fallbackDefinition(model, position);
		} catch (error) {
			if (this._shouldLogFailureBurst('definition-error', 3000)) {
				this.logService.warn(`[ExtHost] definition error ${(error as Error)?.message ?? String(error)}`);
			}
			return this._fallbackDefinition(model, position);
		}
	}

	private async _provideGenericLocations(method: string, model: ITextModel, position: Position): Promise<Location | Location[] | null> {
		try {
			const result = await this._request<any>(method, modelToParams(model, position));
			return result ? this._convertLocations(result) : null;
		} catch {
			return null;
		}
	}

	private async _provideReferences(model: ITextModel, position: Position): Promise<Location[]> {
		try {
			const result = await this._request<any[]>('provideReferences', modelToParams(model, position));
			return Array.isArray(result) ? result.map(l => this._convertLocation(l)) : [];
		} catch {
			return [];
		}
	}

	private async _provideDocumentSymbols(model: ITextModel): Promise<DocumentSymbol[] | null> {
		try {
			const result = await this._request<any[]>('provideDocumentSymbols', {
				uri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
			});
			if (!Array.isArray(result) || !result.length) {
				return null;
			}
			return result.map(s => this._convertDocumentSymbol(s));
		} catch {
			return null;
		}
	}

	private async _provideCodeActions(
		model: ITextModel,
		rangeOrSelection: any,
		context: any,
	): Promise<CodeActionList | null> {
		try {
			const range = {
				start: { line: rangeOrSelection.startLineNumber - 1, character: rangeOrSelection.startColumn - 1 },
				end: { line: rangeOrSelection.endLineNumber - 1, character: rangeOrSelection.endColumn - 1 },
			};
			const result = await this._request<any[]>('provideCodeActions', {
				uri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
				range,
				context: { diagnostics: context.markers || [], triggerKind: context.trigger, only: context.only?.value },
			});
			if (!Array.isArray(result) || !result.length) {
				return null;
			}
			return {
				actions: result.map(a => ({
					title: a.title,
					kind: a.kind,
					diagnostics: a.diagnostics || [],
					isPreferred: a.isPreferred || false,
					edit: a.edit ? this._convertWorkspaceEdit(a.edit) : undefined,
					command: a.command,
				})),
				dispose: () => {},
			} as CodeActionList;
		} catch {
			return null;
		}
	}

	private async _provideCodeLenses(model: ITextModel): Promise<CodeLensList | null> {
		try {
			const result = await this._request<any[]>('provideCodeLenses', {
				uri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
			});
			if (!Array.isArray(result) || !result.length) {
				return null;
			}
			return {
				lenses: result.map(l => ({
					range: toVscRange(l.range),
					command: l.command ? { id: l.command.command || l.command.id, title: l.command.title, arguments: l.command.arguments } : undefined,
				})),
				dispose: () => {},
			};
		} catch {
			return null;
		}
	}

	private async _provideFormatting(model: ITextModel, options: any): Promise<TextEdit[] | null> {
		try {
			const result = await this._request<any[]>('provideFormatting', {
				uri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
				options,
			});
			if (!Array.isArray(result) || !result.length) {
				return null;
			}
			return result.map(e => ({ range: toVscRange(e.range), text: e.newText }));
		} catch {
			return null;
		}
	}

	private async _provideRangeFormatting(model: ITextModel, range: any, options: any): Promise<TextEdit[] | null> {
		try {
			const r = {
				start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
				end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
			};
			const result = await this._request<any[]>('provideRangeFormatting', {
				uri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
				range: r,
				options,
			});
			if (!Array.isArray(result) || !result.length) {
				return null;
			}
			return result.map(e => ({ range: toVscRange(e.range), text: e.newText }));
		} catch {
			return null;
		}
	}

	private async _provideSignatureHelp(model: ITextModel, position: Position, context: any): Promise<SignatureHelpResult | null> {
		try {
			const result = await this._request<any>('provideSignatureHelp', {
				...modelToParams(model, position),
				context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger },
			});
			if (!result?.signatures?.length) {
				return null;
			}
			return {
				value: {
					signatures: result.signatures.map((s: any) => ({
						label: s.label,
						documentation: s.documentation ? { value: typeof s.documentation === 'string' ? s.documentation : s.documentation.value || '' } : undefined,
						parameters: (s.parameters || []).map((p: any) => ({
							label: p.label,
							documentation: p.documentation ? { value: typeof p.documentation === 'string' ? p.documentation : p.documentation.value || '' } : undefined,
						})),
					})),
					activeSignature: result.activeSignature ?? 0,
					activeParameter: result.activeParameter ?? 0,
				},
				dispose: () => {},
			};
		} catch {
			return null;
		}
	}

	private async _provideDocumentHighlights(model: ITextModel, position: Position): Promise<DocumentHighlight[] | null> {
		try {
			const result = await this._request<any[]>('provideDocumentHighlight', modelToParams(model, position));
			if (!Array.isArray(result) || !result.length) {
				return null;
			}
			return result.map(h => ({
				range: toVscRange(h.range),
				kind: h.kind ?? DocumentHighlightKind.Text,
			}));
		} catch {
			return null;
		}
	}

	private async _provideRenameEdits(model: ITextModel, position: Position, newName: string): Promise<WorkspaceEdit & Rejection | null> {
		try {
			const result = await this._request<any>('provideRename', {
				...modelToParams(model, position),
				newName,
			});
			if (!result?.edits?.length) {
				return null;
			}
			return this._convertWorkspaceEdit(result);
		} catch {
			return null;
		}
	}

	private async _resolveRenameLocation(model: ITextModel, position: Position): Promise<RenameLocation | null> {
		try {
			const result = await this._request<any>('prepareRename', modelToParams(model, position));
			if (!result?.range) {
				return null;
			}
			return {
				range: toVscRange(result.range),
				text: result.placeholder || model.getWordAtPosition(position)?.word || '',
			};
		} catch {
			return null;
		}
	}

	private async _provideDocumentLinks(model: ITextModel): Promise<ILinksList | null> {
		try {
			const result = await this._request<any[]>('provideDocumentLinks', {
				uri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
			});
			if (!Array.isArray(result) || !result.length) {
				return null;
			}
			return {
				links: result.map(l => ({
					range: toVscRange(l.range),
					url: l.target ? URI.parse(l.target) : undefined,
				})),
			};
		} catch {
			return null;
		}
	}

	private async _provideFoldingRanges(model: ITextModel): Promise<FoldingRange[] | null> {
		try {
			const result = await this._request<any[]>('provideFoldingRanges', {
				uri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
			});
			if (!Array.isArray(result) || !result.length) {
				return null;
			}
			return result.map(f => ({
				start: f.start + 1,
				end: f.end + 1,
				kind: f.kind !== undefined ? { value: f.kind } : undefined,
			}));
		} catch {
			return null;
		}
	}

	private async _provideInlayHints(model: ITextModel, range: any): Promise<InlayHintList | null> {
		try {
			const r = {
				start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
				end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
			};
			const result = await this._request<any[]>('provideInlayHints', {
				uri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
				range: r,
			});
			if (!Array.isArray(result) || !result.length) {
				return null;
			}
			return {
				hints: result.map(h => ({
					label: typeof h.label === 'string' ? h.label : (Array.isArray(h.label) ? h.label.map((p: any) => ({ label: p.value || '' })) : String(h.label)),
					position: toVscPosition(h.position),
					kind: h.kind,
					paddingLeft: h.paddingLeft,
					paddingRight: h.paddingRight,
				})),
				dispose: () => {},
			};
		} catch {
			return null;
		}
	}


	private _syncOpenDocuments(): void {
		if (!this._documentsSyncInitialized) {
			this._documentsSyncInitialized = true;
			this._register(this.modelService.onModelAdded(model => {
				if (isSyncedModelScheme(model.uri.scheme)) {
					this._notifyDocumentOpened(model);
					this._trackDocumentChanges(model);
				}
			}));
			this._register(this.modelService.onModelRemoved(model => {
				if (!isSyncedModelScheme(model.uri.scheme)) {
					return;
				}
				const uri = model.uri.toString();
				const listener = this._modelContentListeners.get(uri);
				if (listener) {
					listener.dispose();
					this._modelContentListeners.delete(uri);
				}
				this._send({ id: this._nextId(), type: 'documentClosed', params: { uri } });
			}));
			this._register(this.textFileService.files.onDidSave((e) => {
				this._send({
					id: this._nextId(),
					type: 'documentSaved',
					params: { uri: e.model.resource.toString() },
				});
			}));
		}

		for (const model of this.modelService.getModels()) {
			if (isSyncedModelScheme(model.uri.scheme)) {
				this._notifyDocumentOpened(model);
				this._trackDocumentChanges(model);
			}
		}
	}

	private _notifyDocumentOpened(model: ITextModel): void {
		const text = sanitizeForExtHost(model.getValue());
		this._send({
			id: this._nextId(),
			type: 'documentOpened',
			params: {
				uri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
				text,
			},
		});
	}

	private _trackDocumentChanges(model: ITextModel): void {
		const uri = model.uri.toString();
		if (this._modelContentListeners.has(uri)) {
			return;
		}
		const disposable = model.onDidChangeContent(e => {
			if (!this._connected) {
				return;
			}
			const changes = e.changes.map(c => ({
				range: {
					start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
					end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
				},
				rangeOffset: c.rangeOffset,
				rangeLength: c.rangeLength,
				text: sanitizeForExtHost(c.text),
			}));
			const text = sanitizeForExtHost(model.getValue());
			this._send({
				id: this._nextId(),
				type: 'documentChanged',
				params: {
					uri: model.uri.toString(),
					version: model.getVersionId(),
					text,
					changes,
				},
			});
		});
		this._modelContentListeners.set(uri, disposable);
	}

	private _syncActiveEditor(): void {
		if (this._activeEditorSyncInitialized) {
			return;
		}
		this._activeEditorSyncInitialized = true;
		this._register(this.editorService.onDidActiveEditorChange(() => {
			if (this._connected) {
				this._sendActiveEditor();
			}
		}));
	}

	private _sendActiveEditor(): void {
		const editor = this.editorService.activeTextEditorControl;
		const model = editor && 'getModel' in editor ? (editor as any).getModel() as ITextModel | null : null;
		if (model?.uri && isSyncedModelScheme(model.uri.scheme)) {
			this._send({
				id: this._nextId(),
				type: 'activeEditorChanged',
				params: {
					uri: model.uri.toString(),
					languageId: model.getLanguageId(),
				},
			});
		} else {
			this._send({ id: this._nextId(), type: 'activeEditorChanged', params: { uri: null } });
		}
	}

	private _startEditorTracking(): void {
		if (this._editorTrackingInitialized) {return;}
		this._editorTrackingInitialized = true;

		const getEditorId = (editor: ICodeEditor): string => {
			const model = editor.getModel();
			return `${editor.getId()},${model?.id ?? 'null'}`;
		};

		const shouldTrack = (editor: ICodeEditor): boolean => {
			if ((editor as any).isSimpleWidget) {return false;}
			const model = editor.getModel();
			return !!model && isSyncedModelScheme(model.uri.scheme);
		};

		const getEditorState = (editor: ICodeEditor) => {
			const model = editor.getModel()!;
			const selections = editor.getSelections() || [];
			const config = editor.getOptions();
			const visibleRanges = editor.getVisibleRanges() || [];
			return {
				id: getEditorId(editor),
				documentUri: model.uri.toString(),
				selections: selections.map((s: any) => ({
					anchor: { line: s.selectionStartLineNumber - 1, character: s.selectionStartColumn - 1 },
					active: { line: s.positionLineNumber - 1, character: s.positionColumn - 1 },
				})),
				options: {
					tabSize: model.getOptions().tabSize,
					insertSpaces: model.getOptions().insertSpaces,
					cursorStyle: config.get(/* EditorOption.cursorStyle */ 34),
					lineNumbers: config.get(/* EditorOption.lineNumbers */ 76)?.renderType ?? 1,
				},
				visibleRanges: visibleRanges.map((r: any) => ({
					start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
					end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
				})),
				viewColumn: 1,
			};
		};

		const sendDelta = (removed: string[], added: any[], newActive: string | null | undefined) => {
			if (!this._connected) {return;}
			const delta: any = {};
			if (removed.length) {delta.removedEditors = removed;}
			if (added.length) {delta.addedEditors = added;}
			if (newActive !== undefined) {delta.newActiveEditor = newActive;}
			if (Object.keys(delta).length > 0) {
				this._send({ id: this._nextId(), type: 'editorsDelta', params: delta });
			}
		};

		const trackEditor = (editor: ICodeEditor) => {
			if (!shouldTrack(editor)) {return;}
			const editorId = getEditorId(editor);
			if (this._trackedEditors.has(editorId)) {return;}

			const listeners: IDisposable[] = [];

			listeners.push(editor.onDidChangeCursorSelection((e) => {
				if (!this._connected) {return;}
				const model = editor.getModel();
				if (!model || !isSyncedModelScheme(model.uri.scheme)) {return;}
				const allSelections = editor.getSelections() || [];
				this._send({
					id: this._nextId(),
					type: 'editorPropertiesChanged',
					params: {
						editorId,
						selections: {
							selections: allSelections.map((s: any) => ({
								anchor: { line: s.selectionStartLineNumber - 1, character: s.selectionStartColumn - 1 },
								active: { line: s.positionLineNumber - 1, character: s.positionColumn - 1 },
							})),
							source: e.source || 'keyboard',
						},
						options: null,
						visibleRanges: null,
					},
				});
			}));

			listeners.push(editor.onDidChangeConfiguration(() => {
				if (!this._connected) {return;}
				const model = editor.getModel();
				if (!model) {return;}
				const config = editor.getOptions();
				this._send({
					id: this._nextId(),
					type: 'editorPropertiesChanged',
					params: {
						editorId,
						selections: null,
						options: {
							tabSize: model.getOptions().tabSize,
							insertSpaces: model.getOptions().insertSpaces,
							cursorStyle: config.get(34),
							lineNumbers: config.get(76)?.renderType ?? 1,
						},
						visibleRanges: null,
					},
				});
			}));

			listeners.push(editor.onDidScrollChange(() => {
				if (!this._connected) {return;}
				const vr = editor.getVisibleRanges() || [];
				this._send({
					id: this._nextId(),
					type: 'editorPropertiesChanged',
					params: {
						editorId,
						selections: null,
						options: null,
						visibleRanges: vr.map((r: any) => ({
							start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
							end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
						})),
					},
				});
			}));

			listeners.push(editor.onKeyDown((e: any) => {
				if (!this._connected) {return;}
				if (e.keyCode === 9 /* Escape */) {
					const cmd = this._registeredCommands.has('extension.vim_escape') ? 'extension.vim_escape' : null;
					if (cmd) {
						e.preventDefault();
						e.stopPropagation();
						this._request('executeCommand', { command: cmd, args: [] }, { timeoutMs: 1000 }).catch(() => {});
					}
				}
			}));

			const model = editor.getModel()!;
			this._trackedEditors.set(editorId, { editor, uri: model.uri.toString(), listeners });
		};

		const _untrackEditor = (editor: ICodeEditor) => {
			const editorId = getEditorId(editor);
			const entry = this._trackedEditors.get(editorId);
			if (entry) {
				entry.listeners.forEach(l => l.dispose());
				this._trackedEditors.delete(editorId);
			}
			return editorId;
		};

		const updateState = () => {
			if (!this._connected) {return;}

			const currentEditors = new Map<string, ICodeEditor>();
			for (const editor of this.codeEditorService.listCodeEditors()) {
				if (shouldTrack(editor)) {
					currentEditors.set(getEditorId(editor), editor);
				}
			}

			const removed: string[] = [];
			for (const [id] of this._trackedEditors) {
				if (!currentEditors.has(id)) {
					const entry = this._trackedEditors.get(id)!;
					entry.listeners.forEach(l => l.dispose());
					this._trackedEditors.delete(id);
					removed.push(id);
				}
			}

			const added: any[] = [];
			for (const [id, editor] of currentEditors) {
				if (!this._trackedEditors.has(id)) {
					trackEditor(editor);
					added.push(getEditorState(editor));
				}
			}

			let activeId: string | null = null;
			for (const editor of this.codeEditorService.listCodeEditors()) {
				if (editor.hasTextFocus() && shouldTrack(editor)) {
					activeId = getEditorId(editor);
					break;
				}
			}
			if (!activeId) {
				const activeControl = this.editorService.activeTextEditorControl;
				if (activeControl && 'getId' in activeControl && shouldTrack(activeControl as any)) {
					activeId = getEditorId(activeControl as any);
				}
			}

			let activeChanged: string | null | undefined;
			if (!this._initialEditorsDeltaSent) {
				activeChanged = activeId;
				this._activeTrackedEditorId = activeId;
				this._initialEditorsDeltaSent = true;
			} else {
				activeChanged = activeId !== this._activeTrackedEditorId ? activeId : undefined;
				if (activeChanged !== undefined) {this._activeTrackedEditorId = activeId;}
			}

			sendDelta(removed, added, activeChanged);
		};

		const handleAddedEditor = (editor: ICodeEditor) => {
			const listeners: IDisposable[] = [];
			listeners.push(editor.onDidChangeModel(() => updateState()));
			listeners.push(editor.onDidFocusEditorText(() => updateState()));
			updateState();
			return listeners;
		};

		for (const existingEditor of this.codeEditorService.listCodeEditors()) {
			handleAddedEditor(existingEditor);
		}

		this._register(this.codeEditorService.onCodeEditorAdd((editor) => {
			handleAddedEditor(editor);
		}));
		this._register(this.codeEditorService.onCodeEditorRemove(() => updateState()));
		this._register(this.editorService.onDidActiveEditorChange(() => updateState()));

		updateState();
	}


	private static readonly _DIAG_OWNER = 'tauriExtHost';

	private _onDiagnosticsChanged(uri: string, diagnostics: any[]): void {
		if (!uri) {
			return;
		}
		const resource = URI.parse(uri);
		const markers: IMarkerData[] = (diagnostics || []).map(d => {
			const sev = d.severity === 0 ? MarkerSeverity.Error
				: d.severity === 1 ? MarkerSeverity.Warning
				: d.severity === 2 ? MarkerSeverity.Info
				: MarkerSeverity.Hint;
			return {
				severity: sev,
				message: d.message || '',
				source: d.source || '',
				code: d.code || undefined,
				startLineNumber: (d.range?.start?.line ?? 0) + 1,
				startColumn: (d.range?.start?.character ?? 0) + 1,
				endLineNumber: (d.range?.end?.line ?? 0) + 1,
				endColumn: (d.range?.end?.character ?? 0) + 1,
			};
		});
		this.markerService.changeOne(TauriExtensionHostContribution._DIAG_OWNER, resource, markers);
	}


	private async _onApplyEdit(edits: any[]): Promise<void> {
		if (!edits?.length) {
			return;
		}
		try {
			const textEdits = edits.map(e => new ResourceTextEdit(
				URI.parse(e.uri),
				{
					range: toVscRange(e.range),
					text: e.newText,
				},
			));
			await this.bulkEditService.apply(textEdits);
		} catch (e) {
			this.logService.warn('[ExtHost] applyEdit failed:', e);
		}
	}


	private async _onShowTextDocument(uri: string, _options?: any): Promise<void> {
		if (!uri) {
			return;
		}
		try {
			await this.editorService.openEditor({ resource: URI.parse(uri) });
		} catch {
			// best-effort
		}
	}


	private async _onShowQuickPick(requestId: number, items: string[], options: any): Promise<void> {
		try {
			const pickItems = items.map(label => ({ label }));
			const picked = await this.quickInputService.pick(pickItems, { placeHolder: options?.placeHolder });
			const value = picked ? (picked as { label: string }).label : undefined;
			this._send({ id: this._nextId(), type: 'messageResponse', params: { requestId, value } });
		} catch {
			this._send({ id: this._nextId(), type: 'messageResponse', params: { requestId, value: undefined } });
		}
	}

	private async _onShowInputBox(requestId: number, options: any): Promise<void> {
		try {
			const value = await this.quickInputService.input({
				placeHolder: options?.placeHolder,
				prompt: options?.prompt,
				value: options?.value,
				password: options?.password,
			});
			this._send({ id: this._nextId(), type: 'messageResponse', params: { requestId, value } });
		} catch {
			this._send({ id: this._nextId(), type: 'messageResponse', params: { requestId, value: undefined } });
		}
	}

	private async _onShowMessageRequest(requestId: number, severity: string, message: string, items: string[]): Promise<void> {
		if (!items?.length) {
			return;
		}
		try {
			const picked = await this.quickInputService.pick(
				items.map(label => ({ label })),
				{ placeHolder: message },
			);
			const value = picked ? (Array.isArray(picked) ? picked[0]?.label : picked.label) : undefined;
			this._send({ id: this._nextId(), type: 'messageResponse', params: { requestId, value } });
		} catch {
			this._send({ id: this._nextId(), type: 'messageResponse', params: { requestId, value: undefined } });
		}
	}


	private _langConfigDisposables = new Map<string, IDisposable>();

	private _onLanguageConfigurationChanged(language: string, config: any): void {
		if (!language || !config) {
			return;
		}
		this._langConfigDisposables.get(language)?.dispose();

		const langConfig: LanguageConfiguration = {};
		if (config.comments) {
			langConfig.comments = {
				lineComment: config.comments.lineComment ?? null,
				blockComment: config.comments.blockComment ?? null,
			};
		}
		if (config.brackets) {
			langConfig.brackets = config.brackets;
		}
		if (config.autoClosingPairs) {
			langConfig.autoClosingPairs = config.autoClosingPairs;
		}
		if (config.surroundingPairs) {
			langConfig.surroundingPairs = config.surroundingPairs;
		}
		if (config.wordPattern) {
			try { langConfig.wordPattern = new RegExp(config.wordPattern); } catch { /* ignore invalid regex */ }
		}
		if (config.indentationRules) {
			try {
				langConfig.indentationRules = {
					increaseIndentPattern: config.indentationRules.increaseIndentPattern ? new RegExp(config.indentationRules.increaseIndentPattern) : /(?:)/,
					decreaseIndentPattern: config.indentationRules.decreaseIndentPattern ? new RegExp(config.indentationRules.decreaseIndentPattern) : /(?:)/,
				};
			} catch { /* ignore invalid regex */ }
		}

		const disposable = this.langConfigService.register(language, langConfig);
		this._langConfigDisposables.set(language, disposable);
	}


	private _activeWatches = new Map<number, number>(); // watcherId → Tauri watch_id
	private _tauriWatchUnlisten: (() => void) | undefined;

	private async _onStartFileWatch(watcherId: number, paths: string[], pattern: string, recursive: boolean): Promise<void> {
		try {
			const { invoke } = await import('@tauri-apps/api/core');

			let fileExtensions: string[] | undefined;
			const extMatch = pattern.match(/\*\.(\w+)$/);
			if (extMatch) {
				fileExtensions = [extMatch[1]];
			}

			const tauriWatchId = await invoke<number>('watch_start', {
				paths,
				options: {
					recursive: recursive !== false,
					debounce_ms: 200,
					file_extensions: fileExtensions,
					ignore_patterns: ['node_modules', '.git', '*.log'],
					emit_content: false,
				},
			});
			this._activeWatches.set(watcherId, tauriWatchId);
			this.logService.info(`[ExtHost] File watch ${watcherId} started (tauri=${tauriWatchId}) for ${pattern}`);

			if (!this._tauriWatchUnlisten && !this._tauriWatchListenerPromise) {
				this._tauriWatchListenerPromise = this._setupTauriWatchListener()
					.finally(() => {
						this._tauriWatchListenerPromise = undefined;
					});
			}
			await this._tauriWatchListenerPromise;
		} catch (e) {
			this.logService.warn(`[ExtHost] Failed to start file watch for ${pattern}:`, e);
		}
	}

	private async _onStopFileWatch(watcherId: number): Promise<void> {
		const tauriWatchId = this._activeWatches.get(watcherId);
		if (tauriWatchId === undefined) {
			return;
		}
		this._activeWatches.delete(watcherId);
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			await invoke('watch_stop', { id: tauriWatchId });
			this.logService.info(`[ExtHost] File watch ${watcherId} stopped`);
		} catch {
			// best-effort cleanup
		}
	}


	private _toWorkbenchAlignment(apiAlignment: number): StatusbarAlignment {
		return apiAlignment === 2 ? StatusbarAlignment.RIGHT : StatusbarAlignment.LEFT;
	}

	private _makeStatusbarEntry(msg: any) {
		return {
			name: msg.name || msg.id,
			text: msg.text || '',
			ariaLabel: msg.name || msg.id,
			tooltip: msg.tooltip || undefined,
			command: msg.command || undefined,
		};
	}

	private _onStatusBarItemShow(msg: any): void {
		this.logService.info(`[ExtHost] statusBarItemShow: id=${msg.id} text="${msg.text}" alignment=${msg.alignment} priority=${msg.priority}`);
		const existing = this._statusBarItems.get(msg.id);
		if (existing) {
			existing.update(this._makeStatusbarEntry(msg));
			return;
		}
		try {
			const accessor = this.statusbarService.addEntry(
				this._makeStatusbarEntry(msg),
				msg.id,
				this._toWorkbenchAlignment(msg.alignment),
				msg.priority ?? 0,
			);
			this._statusBarItems.set(msg.id, accessor);
			this.logService.info(`[ExtHost] statusBarItem created: ${msg.id}`);
		} catch (e) {
			this.logService.warn(`[ExtHost] statusBarItemShow failed for ${msg.id}:`, e);
		}
	}

	private _onStatusBarItemUpdate(msg: any): void {
		const accessor = this._statusBarItems.get(msg.id);
		if (accessor) {
			accessor.update(this._makeStatusbarEntry(msg));
		} else {
			this._onStatusBarItemShow(msg);
		}
	}

	private _onStatusBarItemHide(id: string): void {
		const accessor = this._statusBarItems.get(id);
		if (accessor) {
			accessor.dispose();
			this._statusBarItems.delete(id);
		}
	}

	private _onStatusBarItemRemove(id: string): void {
		const accessor = this._statusBarItems.get(id);
		if (accessor) {
			accessor.dispose();
			this._statusBarItems.delete(id);
		}
	}

	private _extTerminals = new Map<string, any>();

	private async _onShowOpenDialog(reqId: number, options: any): Promise<void> {
		try {
			const result = await this.fileDialogService.showOpenDialog({
				title: options?.title,
				canSelectFiles: options?.canSelectFiles !== false,
				canSelectFolders: options?.canSelectFolders === true,
				canSelectMany: options?.canSelectMany === true,
				defaultUri: options?.defaultUri ? URI.parse(options.defaultUri.toString()) : undefined,
			});
			const uris = result ? result.map((u: URI) => u.toString()) : undefined;
			this._send({ id: reqId, result: uris });
		} catch {
			this._send({ id: reqId, result: undefined });
		}
	}

	private async _onShowSaveDialog(reqId: number, options: any): Promise<void> {
		try {
			const result = await this.fileDialogService.showSaveDialog({
				title: options?.title,
				defaultUri: options?.defaultUri ? URI.parse(options.defaultUri.toString()) : undefined,
			});
			this._send({ id: reqId, result: result ? result.toString() : undefined });
		} catch {
			this._send({ id: reqId, result: undefined });
		}
	}

	private _activeProgressResolvers = new Map<string, () => void>();

	private _onProgressStart(location: number, title: string): void {
		const key = `${location}:${title}`;
		if (this._activeProgressResolvers.has(key)) {
			return;
		}
		const progressLocation = location === 15 ? ProgressLocation.Notification
			: location === 10 ? ProgressLocation.Window
			: ProgressLocation.Notification;
		this.progressService.withProgress(
			{ location: progressLocation, title },
			() => new Promise<void>((resolve) => {
				this._activeProgressResolvers.set(key, resolve);
			})
		);
	}

	private _onProgressEnd(location: number, title: string): void {
		const key = `${location}:${title}`;
		const resolve = this._activeProgressResolvers.get(key);
		if (resolve) {
			resolve();
			this._activeProgressResolvers.delete(key);
		}
	}

	private _onProgress(_msg: any): void {
	}

	private async _onCreateTerminal(msg: any): Promise<void> {
		try {
			const location = msg.location?.viewColumn !== undefined
				? { splitActiveTerminal: false }
				: undefined;

			const instance = await this.terminalService.createTerminal({
				config: {
					executable: msg.shellPath || undefined,
					args: msg.shellArgs || undefined,
					cwd: msg.cwd || undefined,
					env: msg.env || undefined,
					name: msg.name || undefined,
					strictEnv: msg.strictEnv || false,
					isTransient: msg.isTransient || false,
				},
				location,
			});
			if (instance) {
				this._extTerminals.set(msg.terminalId, instance);
				if (!msg.hideFromUser) {
					this.terminalGroupService.showPanel(true);
				}
			}
		} catch (e) {
			this.logService.warn(`[ExtHost] createTerminal failed:`, e);
		}
	}

	private _onTerminalSendText(id: string, text: string, addNewLine: boolean): void {
		const instance = this._extTerminals.get(id);
		if (instance) {
			instance.sendText(text, addNewLine);
		}
	}

	private _onTerminalShow(id: string): void {
		const instance = this._extTerminals.get(id);
		if (instance) {
			this.terminalGroupService.showPanel(true);
		}
	}

	private _onTerminalDispose(id: string): void {
		const instance = this._extTerminals.get(id);
		if (instance) {
			instance.dispose();
			this._extTerminals.delete(id);
		}
	}

	private async _onStartDebugging(_folder: any, config: any): Promise<void> {
		try {
			await this.debugService.startDebugging(undefined, config);
		} catch (e) {
			this.logService.warn(`[ExtHost] startDebugging failed:`, e);
		}
	}

	private async _onStopDebugging(sessionId?: string): Promise<void> {
		try {
			if (sessionId) {
				const session = this.debugService.getModel().getSessions().find((s: any) => s.getId() === sessionId);
				if (session) {
					await this.debugService.stopSession(session);
					return;
				}
			}
			await this.debugService.stopSession(undefined);
		} catch (e) {
			this.logService.warn(`[ExtHost] stopDebugging failed:`, e);
		}
	}

	private _onOpenExternal(url: string): void {
		try {
			this.openerService.open(URI.parse(url), { allowCommands: false });
		} catch (e) {
			this.logService.warn(`[ExtHost] openExternal failed:`, e);
		}
	}

	private _onCreateWebviewPanel(msg: any): void {
		try {
			const webviewInput = this.webviewWorkbenchService.openWebview(
				{
					providedViewType: msg.viewType,
					title: msg.title,
					options: {
						retainContextWhenHidden: msg.options?.retainContextWhenHidden ?? false,
						enableFindWidget: msg.options?.enableFindWidget ?? false,
					},
					contentOptions: {
						allowScripts: msg.options?.enableScripts ?? true,
						localResourceRoots: [URI.from({ scheme: 'file', path: '/' })],
					},
					extension: undefined,
				},
				msg.viewType,
				msg.title,
				undefined,
				{ preserveFocus: false },
			);
			this._webviewPanels.set(msg.panelId, webviewInput);
			webviewInput.webview.onMessage(e => {
				this._send({
					id: this._nextId(),
					type: 'webviewMessage',
					params: { panelId: msg.panelId, message: e.message },
				});
			});
			webviewInput.onWillDispose(() => {
				this._webviewPanels.delete(msg.panelId);
				this._send({
					id: this._nextId(),
					type: 'webviewPanelClosed',
					params: { panelId: msg.panelId },
				});
			});
		} catch (e) {
			this.logService.warn(`[ExtHost] createWebviewPanel failed:`, e);
		}
	}

	private _onWebviewHtmlUpdate(id: string, html: string): void {
		const panel = this._webviewPanels.get(id);
		if (panel) {
			panel.webview.setHtml(html);
		}
	}

	private _onWebviewPanelUpdate(id: string, title: string): void {
		const panel = this._webviewPanels.get(id);
		if (panel) {
			panel.setWebviewTitle(title);
		}
	}

	private _onWebviewPanelReveal(id: string, _viewColumn: number, preserveFocus: boolean): void {
		const panel = this._webviewPanels.get(id);
		if (panel) {
			this.editorService.openEditor(panel, { preserveFocus });
		}
	}

	private async _onWebviewPanelIcon(id: string, light: string | undefined, dark: string | undefined): Promise<void> {
		const panel = this._webviewPanels.get(id);
		if (!panel || (!light && !dark)) { return; }
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			const darkPath = dark || light || '';
			const svgContent = await invoke<string>('read_file', { path: darkPath }).catch(() => '');
			if (svgContent) {
				const dataUri = URI.parse(`data:image/svg+xml;base64,${btoa(svgContent)}`);
				panel.iconPath = { light: dataUri, dark: dataUri };
			}
		} catch {}
	}

	private _onWebviewPanelDispose(id: string): void {
		const panel = this._webviewPanels.get(id);
		if (panel) {
			panel.dispose();
			this._webviewPanels.delete(id);
		}
	}

	private _getOrCreateTreeView(viewId: string): TreeView | null {
		let treeView = this._treeViews.get(viewId);
		if (treeView) {return treeView;}
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const existing = viewsRegistry.getView(viewId) as ITreeViewDescriptor | null;
		if (existing?.treeView) {
			return existing.treeView as unknown as TreeView;
		}
		try {
			treeView = this.instantiationService.createInstance(TreeView, viewId, viewId);
			this._treeViews.set(viewId, treeView);
			const explorerContainer = viewsRegistry.getViewContainer?.('workbench.view.explorer');
			if (explorerContainer) {
				viewsRegistry.registerViews([{
					id: viewId,
					name: { value: viewId, original: viewId },
					ctorDescriptor: new SyncDescriptor(TreeViewPane),
					treeView,
					canToggleVisibility: true,
					collapsed: true,
				} as ITreeViewDescriptor], explorerContainer);
			}
			return treeView;
		} catch (e) {
			this.logService.warn(`[ExtHost] createTreeView failed:`, e);
			return null;
		}
	}

	private _onRegisterTreeDataProvider(viewId: string): void {
		this._getOrCreateTreeView(viewId);
		this._send({ id: this._nextId(), type: 'activateByEvent', params: { event: `onView:${viewId}` } });
	}

	private _onCreateTreeView(viewId: string, canSelectMany: boolean): void {
		const tv = this._getOrCreateTreeView(viewId);
		if (tv && canSelectMany) {
			tv.canSelectMany = canSelectMany;
		}
		this._send({ id: this._nextId(), type: 'activateByEvent', params: { event: `onView:${viewId}` } });
	}

	private _onTreeViewUpdate(viewId: string, msg: any): void {
		const tv = this._getOrCreateTreeView(viewId);
		if (!tv) {return;}
		if (msg.message !== undefined) {tv.message = msg.message;}
		if (msg.title !== undefined) {tv.title = msg.title;}
		if (msg.description !== undefined) {tv.description = msg.description;}
	}

	private async _setupTauriWatchListener(): Promise<void> {
		if (this._tauriWatchUnlisten) {
			return;
		}
		try {
			const { listen } = await import('@tauri-apps/api/event');
			const unlisten = await listen<{ watch_id: number; events: { path: string; kind: string; is_dir: boolean }[] }>('watch-batch', (event) => {
				if (!this._connected) {
					return;
				}
				this._send({
					id: this._nextId(),
					type: 'fileWatchEvent',
					params: { events: event.payload.events },
				});
			});
			this._tauriWatchUnlisten = unlisten;
		} catch (e) {
			this.logService.warn('[ExtHost] Failed to setup Tauri watch listener:', e);
		}
	}


	private async _provideSelectionRanges(model: ITextModel, positions: Position[]): Promise<SelectionRange[][] | null> {
		try {
			const result = await this._request<any[][]>('provideSelectionRanges', {
				uri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
				positions: positions.map(p => ({ line: p.lineNumber - 1, character: p.column - 1 })),
			});
			if (!Array.isArray(result)) {
				return null;
			}
			return result.map(positionRanges => {
				const ranges: SelectionRange[] = [];
				let current: any = Array.isArray(positionRanges) ? positionRanges[0] : positionRanges;
				while (current) {
					ranges.push({ range: toVscRange(current.range || current) });
					current = current.parent;
				}
				return ranges;
			});
		} catch {
			return null;
		}
	}

	private _semanticTokensLegend: SemanticTokensLegend = { tokenTypes: [], tokenModifiers: [] };

	private async _provideSemanticTokens(model: ITextModel): Promise<SemanticTokens | null> {
		try {
			const result = await this._request<any>('provideSemanticTokens', {
				uri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
			});
			if (!result?.data) {
				return null;
			}
			return {
				data: new Uint32Array(result.data),
				resultId: result.resultId,
			};
		} catch {
			return null;
		}
	}

	private async _provideDocumentColors(model: ITextModel): Promise<IColorInformation[] | null> {
		try {
			const result = await this._request<any[]>('provideDocumentColors', {
				uri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
			});
			if (!Array.isArray(result) || !result.length) {
				return null;
			}
			return result.map(c => ({
				range: toVscRange(c.range),
				color: { red: c.color.red, green: c.color.green, blue: c.color.blue, alpha: c.color.alpha },
			}));
		} catch {
			return null;
		}
	}


	private _normalizeCompletionItems(items: any[]): CompletionItem[] {
		const normalized: CompletionItem[] = [];
		let dropped = 0;
		for (const item of items) {
			const converted = this._tryConvertCompletionItem(item);
			if (converted) {
				normalized.push(converted);
			} else {
				dropped++;
			}
		}
		if (dropped > 0 && this._shouldLogFailureBurst('completion-dropped-items', 10000)) {
			this.logService.warn(`[ExtHost] completion dropped malformed items ${JSON.stringify({ dropped, accepted: normalized.length })}`);
		}
		return normalized;
	}

	private _tryConvertCompletionItem(item: any): CompletionItem | null {
		const label = typeof item?.label === 'string'
			? item.label
			: (typeof item?.label?.label === 'string' ? item.label.label : '');
		if (!label.trim()) {
			return null;
		}

		let range: CompletionItem['range'] = undefined;
		if (item.range) {
			try {
				range = toVscRange(item.range);
			} catch {
				range = undefined;
			}
		}

		const documentationValue = item.documentation === undefined || item.documentation === null
			? undefined
			: (typeof item.documentation === 'string'
				? item.documentation
				: (typeof item.documentation?.value === 'string' ? item.documentation.value : String(item.documentation)));

		return {
			label,
			kind: typeof item.kind === 'number' ? item.kind : CompletionItemKind.Text,
			detail: typeof item.detail === 'string' ? item.detail : undefined,
			documentation: documentationValue ? { value: documentationValue } : undefined,
			insertText: typeof item.insertText === 'string' && item.insertText.length > 0 ? item.insertText : label,
			range,
			sortText: typeof item.sortText === 'string' ? item.sortText : undefined,
			filterText: typeof item.filterText === 'string' ? item.filterText : undefined,
			preselect: Boolean(item.preselect),
		} as CompletionItem;
	}

	private _convertLocation(loc: any): Location {
		return {
			uri: URI.parse(loc.uri),
			range: toVscRange(loc.range),
		};
	}

	private _convertLocations(result: any): Location | Location[] {
		return Array.isArray(result)
			? result.map(l => this._convertLocation(l))
			: this._convertLocation(result);
	}

	private _convertDocumentSymbol(s: any): DocumentSymbol {
		return {
			name: s.name,
			detail: s.detail || '',
			kind: s.kind ?? SymbolKind.Variable,
			tags: [],
			range: toVscRange(s.range),
			selectionRange: toVscRange(s.selectionRange || s.range),
			children: (s.children || []).map((c: any) => this._convertDocumentSymbol(c)),
		} as DocumentSymbol;
	}

	private _convertWorkspaceEdit(edit: any): WorkspaceEdit & Rejection {
		const edits: IWorkspaceTextEdit[] = (edit.edits || []).map((e: any) => ({
			resource: URI.parse(e.uri),
			versionId: undefined,
			textEdit: {
				range: toVscRange(e.range),
				text: e.newText,
			},
		}));
		return { edits } as WorkspaceEdit & Rejection;
	}
}

registerWorkbenchContribution2(
	TauriExtensionHostContribution.ID,
	TauriExtensionHostContribution,
	WorkbenchPhase.AfterRestored,
);
