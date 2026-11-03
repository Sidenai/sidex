/*---------------------------------------------------------------------------------------------
 *  Sidex Chat Service — WebSocket client for sidex-server with full workspace context
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { LocalToolExecutor, ILocalToolRequest, LOCAL_TOOLS_SUPPORTED } from './localToolExecutor.js';
import { SubagentRegistry, SubagentType, SUBAGENT_CONFIGS, getAllowedTools, buildSubagentPrompt } from './subagentTypes.js';
import { IExplorerService } from '../../files/browser/files.js';
import { resolveServerEndpoint, serverWsUrl, SERVER_RESTARTED_EVENT } from './localServer.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IUpdateService } from '../../../../platform/update/common/update.js';
import { IRecentEditTracker } from '../../sidexComplete/browser/recentEditTracker.js';

export interface IWorkspaceContext {
	activeFile: string | null;
	language: string | null;
	selection: string | null;
	selectionRange: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null;
	workspaceFolders: string[];
	cwd: string;
	openFiles: string[];
}

export interface IChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	thinkingContent?: string;
	toolCalls?: IToolCallInfo[];
	timestamp: number;
	checkpointLabel?: string;
}

export interface IToolCallInfo {
	id: string;
	name: string;
	input: string;
	output?: string;
	status: 'running' | 'done' | 'error';
}

export interface IStreamChunk {
	type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'done' | 'session' | 'usage'
		| 'cost_update' | 'cost_summary' | 'mode_change' | 'brief' | 'tick' | 'notice'
		| 'thinking' | 'thinking_done' | 'permission_request' | 'turn_complete'
		| 'subagent_spawned' | 'subagent_update' | 'subagent_complete'
		| 'subagent_start' | 'subagent_running' | 'subagent_done'
		| 'ask_question' | 'checkpoint_created' | 'checkpoint_restored';
	content?: string;
	error?: string;
	done?: boolean;
	tool_calls?: Array<{
		id: string;
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
	tokens_used?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
	usage?: { input_tokens: number; output_tokens: number };
	cost?: number;
	turn_cost?: number;
	total_cost?: number;
	total_input_tokens?: number;
	total_output_tokens?: number;
	mode?: string;
	// Permission request fields
	tool_name?: string;
	args?: Record<string, unknown>;
	// Subagent fields
	subagent_id?: string;
	subagent_description?: string;
	subagent_model?: string;
	subagent_status?: 'running' | 'completed' | 'failed';
	subagent_prompt?: string;
	subagent_tools?: Array<{ name: string; status: string }>;
	subagent_output?: string;
	// AskQuestion fields
	question_id?: string;
	question_prompt?: string;
	question_options?: Array<{ id: string; label: string }>;
	question_allow_multiple?: boolean;
	question_title?: string;
	// Checkpoint fields
	checkpoint_label?: string;
	checkpoint_timestamp?: number;
	checkpoint_file_count?: number;
	checkpoint_files?: string[];
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';
export type AgentMode = 'agent' | 'plan' | 'ask';
export type PermissionMode = 'default' | 'auto_edits' | 'plan_only' | 'auto_all';

export const ISidexChatService = createDecorator<ISidexChatService>('sidexChatService');

export interface ISidexChatService {
	readonly _serviceBrand: undefined;

	readonly messages: readonly IChatMessage[];
	readonly revertedMessages: readonly IChatMessage[];
	readonly connectionState: ConnectionState;
	readonly sessionId: string | null;
	readonly isStreaming: boolean;
	readonly isThinking: boolean;
	readonly currentMode: AgentMode;
	readonly serverModel: string;
	readonly lastPromptTokens: number;
	readonly contextWindow: number;
	readonly workspacePath: string | null;

	readonly onDidReceiveChunk: Event<IStreamChunk>;
	readonly onDidChangeMessages: Event<readonly IChatMessage[]>;
	readonly onDidChangeConnectionState: Event<ConnectionState>;
	readonly onDidChangeStreaming: Event<boolean>;

	connect(): void;
	disconnect(): void;
	sendMessage(text: string): void;
	clearMessages(): void;
	stopStreaming(): void;
	setMode(mode: AgentMode): void;
	setMaxMode(on: boolean): void;
	get maxMode(): boolean;
	setThinkingBudget(budget: number): void;
	setThinkingEffort(level: string): void;
	get thinkingBudget(): number;
	setSelectedModel(modelId: string): void;
	setPermissionMode(mode: PermissionMode): void;
	respondToPermission(toolCallId: string, approved: boolean): void;
	respondToQuestion(toolCallId: string, selectedIds: string[]): void;
	revertToMessage(messageIndex: number): void;
	redoCheckpoint(): void;
	getSavedSessions(): Array<{ id: string; title: string; date: string; messageCount: number; pinned?: boolean; archived?: boolean }>;
	getSavedSessionsAsync(): Promise<Array<{ id: string; title: string; date: string; messageCount: number; pinned?: boolean; archived?: boolean }>>;
	loadSession(sessionId: string): void;
	loadSessionAsync(sessionId: string): Promise<void>;
	deleteSession(sessionId: string): Promise<void>;
	pinSession(sessionId: string, pinned: boolean): Promise<void>;
	archiveSession(sessionId: string, archived: boolean): Promise<void>;
	renameSession(sessionId: string, title: string): Promise<void>;
	searchSessions(query: string): Promise<Array<{ id: string; title: string; date: string; messageCount: number; pinned?: boolean; archived?: boolean }>>;
	readonly onDidChangeModels: Event<Array<{ id: string; name: string; provider: string }>>;
	readonly availableModels: Array<{ id: string; name: string; provider: string; contextWindow?: number }>;
	refreshModels(): void;
}

export class SidexChatService extends Disposable implements ISidexChatService {
	declare readonly _serviceBrand: undefined;

	// Keep a global ref so UI components without DI can access chat state
	static INSTANCE: SidexChatService | null = null;

	private _ws: WebSocket | null = null;
	private _messages: IChatMessage[] = [];
	private _revertedMessages: IChatMessage[] = [];
	private _connectionState: ConnectionState = 'disconnected';
	private _sessionId: string | null = null;
	private _dbSessionId: string | null = null;
	private _currentAssistantMessage: IChatMessage | null = null;
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _reconnectAttempts = 0;
	private _isStreaming = false;
	private _isThinking = false;
	private _currentMode: AgentMode = 'agent';
	private _permissionMode: PermissionMode = 'default';
	private _serverModel = '';
	private _maxMode = false;
	private _thinkingBudget = 0;
	private _thinkingEffort = 'none';
	private _lastPromptTokens = 0;
	private _sessionCost = 0;
	private _availableModels: Array<{ id: string; name: string; provider: string; contextWindow?: number }> = [];
	private _sessionGitStatus: string | null = null;
	private _gitStatusSent = false;
	private _osInfo: { platform: string; arch: string; shell: string } | null = null;

	private static readonly MODEL_STORAGE_KEY = 'sidex.selectedModel';
	private static DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
	private static readonly MAX_SAVED_SESSIONS = 50;
	private static readonly MAX_RECENT_EDIT_CONTEXT = 5;
	private readonly _localExecutor = new LocalToolExecutor(() => ({
		cwd: this._gatherWorkspaceContext().cwd,
	}));
	private readonly _subagentRegistry = new SubagentRegistry();
	private _contextIndexed = false;

	/** Tool names whose execution makes the semantic index stale. */
	private static readonly EDIT_TOOLS = new Set([
		'edit_file', 'write_file', 'multi_edit', 'create_file',
		'str_replace_editor', 'delete_file', 'regex_replace', 'patch_file',
	]);
	/** Set when the agent edits files during a turn; consumed on 'done'. */
	private _indexDirty = false;
	private _reindexTimer: ReturnType<typeof setTimeout> | undefined;
	private _reindexInterval: ReturnType<typeof setInterval> | undefined;
	private _contextIndexing = false;
	private _cachedSessions: Array<{ id: string; title: string; date: string; messageCount: number; pinned?: boolean; archived?: boolean }> = [];
	private _dbSessionCreated = false;
	private _msgCounter = 0;
	private readonly _persistedMessages = new Set<IChatMessage>();

	private readonly _onDidReceiveChunk = this._register(new Emitter<IStreamChunk>());
	readonly onDidReceiveChunk = this._onDidReceiveChunk.event;

	private readonly _onDidChangeMessages = this._register(new Emitter<readonly IChatMessage[]>());
	readonly onDidChangeMessages = this._onDidChangeMessages.event;

	private readonly _onDidChangeConnectionState = this._register(new Emitter<ConnectionState>());
	readonly onDidChangeConnectionState = this._onDidChangeConnectionState.event;

	private readonly _onDidChangeStreaming = this._register(new Emitter<boolean>());
	readonly onDidChangeStreaming = this._onDidChangeStreaming.event;

	private readonly _onDidChangeModels = this._register(new Emitter<Array<{ id: string; name: string; provider: string }>>());
	readonly onDidChangeModels = this._onDidChangeModels.event;


	get messages(): readonly IChatMessage[] { return this._messages; }
	get revertedMessages(): readonly IChatMessage[] { return this._revertedMessages; }
	get connectionState(): ConnectionState { return this._connectionState; }
	get sessionId(): string | null { return this._dbSessionId ?? this._sessionId; }
	get isStreaming(): boolean { return this._isStreaming; }
	get isThinking(): boolean { return this._isThinking; }
	get currentMode(): AgentMode { return this._currentMode; }
	get serverModel(): string { return this._serverModel; }
	get lastPromptTokens(): number { return this._lastPromptTokens; }
	get contextWindow(): number {
		const listed = this._availableModels.find(m => m.id === this._serverModel);
		if (listed?.contextWindow && listed.contextWindow > 0) {
			return listed.contextWindow;
		}
		return contextWindowForModel(this._serverModel);
	}
	get availableModels(): Array<{ id: string; name: string; provider: string }> { return this._availableModels; }

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@IProductService private readonly productService: IProductService,
		@IUpdateService private readonly updateService: IUpdateService,
		@IRecentEditTracker private readonly recentEditTracker: IRecentEditTracker,
	) {
		super();
		SidexChatService.INSTANCE = this;
		// Restore saved model or use default immediately
		try {
			const saved = localStorage.getItem(SidexChatService.MODEL_STORAGE_KEY);
			this._serverModel = saved || SidexChatService.DEFAULT_MODEL;
		} catch {
			this._serverModel = SidexChatService.DEFAULT_MODEL;
		}

		// Re-filter model list whenever the user changes enabled models in Settings
		const onModelsChanged = () => this.refreshModels();
		window.addEventListener('sidex-models-changed', onModelsChanged);
		this._register({ dispose: () => window.removeEventListener('sidex-models-changed', onModelsChanged) });

		// Fetch real OS info from Tauri
		this._fetchOsInfo();
		
		// Fetch models immediately, don't wait for WebSocket
		this._fetchServerInfo();


		// A restart we asked for is not an outage: drop the dead socket and
		// reconnect straight away instead of backing off.
		const onServerRestarted = () => {
			this._reconnectAttempts = 0;
			this._ws?.close();
			this._ws = null;
			this._setConnectionState('disconnected');
			this.connect();
		};
		window.addEventListener(SERVER_RESTARTED_EVENT, onServerRestarted);
		this._register({ dispose: () => window.removeEventListener(SERVER_RESTARTED_EVENT, onServerRestarted) });

		// Give the local server a moment to bind its port before connecting.
		setTimeout(() => {
			if (this._connectionState === 'disconnected') {
				this.connect();
			}
		}, 1500);

		// Workspace indexing is a LOCAL feature — it must run regardless of
		// sign-in state or chat-socket connectivity. (It previously only
		// triggered on WebSocket open, so signed-out users never indexed.)
		setTimeout(() => this._triggerWorkspaceIndexing(), 2500);
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => {
			this._contextIndexed = false;
			this._triggerWorkspaceIndexing();
		}));
	}

	/** Kick off local workspace indexing. */
	private _triggerWorkspaceIndexing(): void {
		this._triggerContextIndex();
		this._triggerAutoIndex();
	}

	setMode(mode: AgentMode): void {
		this._currentMode = mode;
	}

	setMaxMode(on: boolean): void {
		this._maxMode = on;
	}

	get maxMode(): boolean { return this._maxMode; }

	setThinkingBudget(budget: number): void {
		this._thinkingBudget = budget;
	}

	setThinkingEffort(level: string): void {
		this._thinkingEffort = (level || 'none').toLowerCase();
	}

	get thinkingBudget(): number { return this._thinkingBudget; }

	get workspacePath(): string | null {
		const folders = this.contextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri.fsPath : null;
	}

	setSelectedModel(modelId: string): void {
		this._serverModel = modelId;
		try { localStorage.setItem(SidexChatService.MODEL_STORAGE_KEY, modelId); } catch { /* */ }
	}

	setPermissionMode(mode: PermissionMode): void {
		this._permissionMode = mode;
	}

	respondToPermission(toolCallId: string, approved: boolean): void {
		if (this._ws && this._connectionState === 'connected') {
			this._ws.send(JSON.stringify({
				type: 'permission_response',
				tool_call_id: toolCallId,
				approved,
			}));
		}
	}

	respondToQuestion(toolCallId: string, selectedIds: string[]): void {
		if (this._ws && this._connectionState === 'connected') {
			this._ws.send(JSON.stringify({
				type: 'tool_response',
				tool_call_id: toolCallId,
				output: JSON.stringify({ selected: selectedIds }),
				error: '',
			}));
		}
	}

	private get _serverUrl(): string {
		// Defaults to the loopback server the app supervises; an explicit
		// setting wins so a user can point at their own instance.
		return serverWsUrl(this.configurationService.getValue<string>('sidex.chat.serverUrl'));
	}

	/**
	 * Builds the /v1/stream WebSocket URL. The server listens on loopback and
	 * serves only the local user, so no token is attached.
	 */
	private _buildStreamUrl(): string {
		const version = this.productService.version || '0.1.3';
		return `${this._serverUrl}/v1/stream?version=${encodeURIComponent(version)}`;
	}

	private get _useDynamicContext(): boolean {
		return this.configurationService.getValue<boolean>('sidex.chat.useDynamicContext') ?? false;
	}

	private _gatherWorkspaceContext(): IWorkspaceContext {
		const activeUri = this.editorService.activeEditor?.resource;
		const activeFile = activeUri?.fsPath ?? null;
		const language = this.editorService.activeTextEditorLanguageId ?? null;

		let selection: string | null = null;
		let selectionRange: IWorkspaceContext['selectionRange'] = null;
		const control = this.editorService.activeTextEditorControl;
		if (control && isCodeEditor(control) && control.hasModel()) {
			const sel = control.getSelection();
			if (sel && !sel.isEmpty()) {
				selection = control.getModel()!.getValueInRange(sel);
				selectionRange = {
					startLine: sel.startLineNumber,
					startColumn: sel.startColumn,
					endLine: sel.endLineNumber,
					endColumn: sel.endColumn,
				};
			}
		}

		const folders = this.contextService.getWorkspace().folders.map(f => f.uri.fsPath);

		const openFiles: string[] = [];
		for (const group of this.editorGroupsService.groups) {
			for (const editor of group.editors) {
				if (editor.resource) {
					openFiles.push(editor.resource.fsPath);
				}
			}
		}

		return {
			activeFile,
			language,
			selection,
			selectionRange,
			workspaceFolders: folders,
			cwd: folders[0] ?? '',
			openFiles,
		};
	}

	private _fetchGitStatus(): void {
		if (!LOCAL_TOOLS_SUPPORTED()) {
			return;
		}
		const ctx = this._gatherWorkspaceContext();
		this._localExecutor.execute({
			type: 'tool_request',
			tool_call_id: `git-status-${Date.now()}`,
			name: 'git_status',
			arguments: JSON.stringify({ cwd: ctx.cwd }),
		}).then(result => {
			if (result.output && !result.error) {
				this._sessionGitStatus = result.output;
			}
		}).catch(() => { /* git status is best-effort */ });
	}

	connect(): void {
		if (this._ws && this._connectionState !== 'disconnected') {
			return;
		}

		// The port is assigned when the server process starts, so it must be
		// known before the socket is opened — otherwise the first attempt goes
		// to the default port and fails. Later calls hit the resolver's cache.
		this._setConnectionState('connecting');
		void resolveServerEndpoint().then(ep => {
			if (!ep.running || ep.port <= 0) {
				this._setConnectionState('disconnected');
				if (this._reconnectAttempts === 0) {
					const why = ep.error?.trim()
						|| 'The local AI server is not running. Chat cannot send until sidex-server is built and the app is restarted.';
					this._onDidReceiveChunk.fire({ type: 'error', content: why } as IStreamChunk);
				}
				this._scheduleReconnect();
				return;
			}
			this._openSocket();
		});
	}

	private _openSocket(): void {
		if (this._ws) {
			return;
		}

		try {
			const url = this._buildStreamUrl();
			this._ws = new WebSocket(url);

			this._ws.onopen = () => {
				this._reconnectAttempts = 0;
				this._setConnectionState('connected');
				this._fetchServerInfo();
			};

			this._ws.onmessage = (event) => {
				try {
					const raw = JSON.parse(event.data);
					if (raw && raw.type === 'update_available') {
						console.log('[sidex-update] Server pushed update-available event, triggering check...');
						this.updateService.checkForUpdates(false);
						return;
					}
					if (raw && raw.type === 'tool_request') {
						void this._handleLocalToolRequest(raw as ILocalToolRequest);
						return;
					}
					this._handleChunk(raw as IStreamChunk);
				} catch {
					// ignore parse errors
				}
			};

			this._ws.onclose = (event) => {
				console.warn('[sidex-ws] CLOSED code:', event.code, 'reason:', event.reason, 'wasClean:', event.wasClean);
				this._ws = null;
				this._setConnectionState('disconnected');
				this._setStreaming(false);
				// Connection lost (1006 = abnormal close, server restart after a
				// credential change, HMR reload, etc.)
				this._scheduleReconnect();
			};

			this._ws.onerror = (ev) => {
				console.error('[sidex-ws] ERROR:', ev);
				this._ws?.close();
			};
		} catch (e) {
			console.error('[sidex-ws] Exception creating WebSocket:', e);
			this._setConnectionState('disconnected');
			this._scheduleReconnect();
		}
	}

	disconnect(): void {
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		this._reconnectAttempts = 0;

		if (this._ws) {
			this._ws.onclose = null;
			this._ws.close();
			this._ws = null;
		}
		this._setConnectionState('disconnected');
		this._setStreaming(false);
	}

	sendMessage(text: string): void {
		this._enqueueUserMessage(text);

		if (!this._ws || this._connectionState !== 'connected') {
			console.warn('[sidex-ws] Not connected, attempting reconnect...');
			this.connect();
			const disposable = this._onDidChangeConnectionState.event((state) => {
				if (state === 'connected') {
					disposable.dispose();
					this.sendMessage(text);
				}
			});
			setTimeout(() => {
				disposable.dispose();
				if (this._connectionState !== 'connected') {
					this._setStreaming(false);
					this._onDidReceiveChunk.fire({
						type: 'error',
						content: 'Unable to reach the server. Please check your connection and try again.',
					} as IStreamChunk);
				}
			}, 5000);
			return;
		}

		this._setStreaming(true);
		void this._sendWithContext(text);
	}

	/** Show the user's turn immediately, even if the socket is down. */
	private _enqueueUserMessage(text: string): void {
		if (!this._sessionId) {
			this._sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			this._gitStatusSent = false;
			this._fetchGitStatus();
		}

		const lastMsg = this._messages[this._messages.length - 1];
		if (lastMsg && lastMsg.role === 'user' && lastMsg.content === text) {
			return;
		}

		const checkpointLabel = `msg-${Date.now()}`;
		const userMsg: IChatMessage = {
			role: 'user',
			content: text,
			timestamp: Date.now(),
			checkpointLabel,
		};
		this._messages.push(userMsg);
		this._revertedMessages = [];
		this._onDidChangeMessages.fire(this._messages);
		void this._createCheckpoint(checkpointLabel);
		void this._persistUserMessage(userMsg);
	}

	revertToMessage(messageIndex: number): void {
		const msg = this._messages[messageIndex];
		if (!msg || msg.role !== 'user' || !msg.checkpointLabel) {
			return;
		}

		void this._rollbackToCheckpoint(msg.checkpointLabel);

		// Store reverted messages for redo instead of permanently deleting
		this._revertedMessages = this._messages.slice(messageIndex + 1);
		this._messages = this._messages.slice(0, messageIndex + 1);
		this._currentAssistantMessage = null;
		this._setStreaming(false);
		this._onDidChangeMessages.fire(this._messages);

		// Tell the server to forget messages after this point in the session.
		// The server counts user-authored messages, so send how many of those
		// survive the revert (the reverted-to user message is the last one kept).
		if (this._ws && this._connectionState === 'connected') {
			const keepUserMessages = this._messages
				.slice(0, messageIndex + 1)
				.filter(m => m.role === 'user').length;
			this._ws.send(JSON.stringify({
				type: 'revert',
				session_id: this._sessionId,
				keep_user_messages: keepUserMessages,
			}));
		}
	}

	redoCheckpoint(): void {
		if (this._revertedMessages.length === 0) {
			return;
		}
		this._messages = this._messages.concat(this._revertedMessages);
		this._revertedMessages = [];
		this._onDidChangeMessages.fire(this._messages);
	}

	private async _createCheckpoint(label: string): Promise<void> {
		const invoke = SidexChatService._getTauriInvoke();
		if (!invoke) { return; }
		try {
			await invoke('checkpoint_create', { label });
		} catch { /* checkpoint creation is best-effort */ }
	}

	private async _rollbackToCheckpoint(label: string): Promise<void> {
		const invoke = SidexChatService._getTauriInvoke();
		if (!invoke) { return; }
		try {
			await invoke('checkpoint_rollback', { label });
		} catch { /* rollback is best-effort */ }
	}

	private async _sendWithContext(text: string): Promise<void> {
		let contextPrefix = '';
		const codebaseMatch = text.match(/@codebase\s*(.*)/);
		if (LOCAL_TOOLS_SUPPORTED() && this._contextIndexed && (this._useDynamicContext || codebaseMatch)) {
			const searchQuery = codebaseMatch ? codebaseMatch[1].trim() || text : text;
			const searchLimit = codebaseMatch ? 15 : 10;
			const searchBudget = codebaseMatch ? 6000 : 4000;

			try {
				const result = await this._localExecutor.execute({
					type: 'tool_request',
					tool_call_id: `ctx-search-${Date.now()}`,
					name: 'context_search',
					arguments: JSON.stringify({ query: searchQuery, limit: searchLimit, budget: searchBudget }),
				});
				if (result.output && !result.error) {
					contextPrefix = `<workspace_context>\n${result.output}\n</workspace_context>\n\n`;
				}
			} catch {
				// Context search failed silently — send without context
			}
		}

		if (!this._ws || this._connectionState !== 'connected') {
			return;
		}

		const ctx = this._gatherWorkspaceContext();
		const localToolsAvailable = LOCAL_TOOLS_SUPPORTED();
		const recentEditContext = this._buildRecentEditContext();

		// Tool routing lives in the server system prompt (LocalExec). Putting it
		// in the user turn as <system_instruction> makes Claude treat it as an
		// injected fake system block and ignore it — especially on a Claude Code
		// login, whose first system block is "You are Claude Code".
		const messageText = contextPrefix + recentEditContext + text;

		const payload = {
			session_id: this._sessionId || '',
			message: messageText,
			mode: this._currentMode,
			model: this._serverModel,
			permission_mode: this._permissionMode,
			cwd: ctx.cwd,
			local_exec: localToolsAvailable,
			tool_execution: localToolsAvailable ? 'local' : 'server',
			dynamic_context: this._useDynamicContext,
			max_mode: this._maxMode,
			thinking_budget: this._thinkingBudget,
			thinking_effort: this._thinkingEffort,
			timestamp: new Date().toLocaleString('en-US', {
				weekday: 'long',
				year: 'numeric',
				month: 'short',
				day: 'numeric',
				hour: 'numeric',
				minute: '2-digit',
				hour12: true,
				timeZoneName: 'short',
			}),
			open_files: ctx.openFiles.slice(0, 10),
			active_file: ctx.activeFile || '',
			git_status: this._gitStatusSent ? undefined : (this._sessionGitStatus || undefined),
			user_info: {
				os: this._osInfo?.platform || 'unknown',
				arch: this._osInfo?.arch || 'unknown',
				shell: this._osInfo?.shell || 'zsh',
				workspace_path: ctx.cwd,
				is_git_repo: this._sessionGitStatus ? true : false,
				date: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
			},
			context: {
				active_file: ctx.activeFile,
				language: ctx.language,
				selection: ctx.selection,
				selection_range: ctx.selectionRange,
				workspace_folders: ctx.workspaceFolders,
				open_files: this._useDynamicContext
					? ctx.openFiles.slice(0, 10).map(f => f.split('/').pop() || f)
					: ctx.openFiles,
			},
		};

		if (!this._gitStatusSent && this._sessionGitStatus) {
			this._gitStatusSent = true;
		}

		this._ws.send(JSON.stringify(payload));
	}

	private _buildRecentEditContext(): string {
		try {
			const edits = this.recentEditTracker
				.getRecentEdits(SidexChatService.MAX_RECENT_EDIT_CONTEXT)
				.filter(edit => edit.trim().length > 0);
			if (edits.length === 0) {
				return '';
			}
			return `<recent_user_edits>\nThese are recent editor edits from this IDE session. Use them to resolve references like "add it back", "undo that", or "the change I just made".\n${edits.join('\n\n')}\n</recent_user_edits>\n\n`;
		} catch {
			return '';
		}
	}

	clearMessages(): void {
		this._messages = [];
		this._revertedMessages = [];
		this._sessionId = null;
		this._dbSessionId = null;
		this._dbSessionCreated = false;
		this._dbSessionPromise = null;
		this._msgCounter = 0;
		this._persistedMessages.clear();
		this._currentAssistantMessage = null;
		this._lastPromptTokens = 0;
		this._sessionCost = 0;
		this._setStreaming(false);
		this._onDidChangeMessages.fire(this._messages);
	}

	getSavedSessions(): Array<{ id: string; title: string; date: string; messageCount: number; pinned?: boolean; archived?: boolean }> {
		void this._refreshCachedSessions();
		return this._cachedSessions;
	}

	async getSavedSessionsAsync(): Promise<Array<{ id: string; title: string; date: string; messageCount: number; pinned?: boolean; archived?: boolean }>> {
		await this._refreshCachedSessions();
		return this._cachedSessions;
	}

	loadSession(sessionId: string): void {
		void this.loadSessionAsync(sessionId);
	}

	async loadSessionAsync(sessionId: string): Promise<void> {
		const invoke = SidexChatService._getTauriInvoke();
		if (!invoke) { return; }
		try {
			const dbMessages = await invoke('session_load', { sessionId }) as Array<{
				id: string; session_id: string; role: string; content: string;
				tool_calls: string | null; tool_call_id: string | null; created_at: number;
			}>;
			this._messages = dbMessages.map(m => {
				const msg: IChatMessage = {
					role: m.role as IChatMessage['role'],
					content: m.content,
					timestamp: m.created_at * 1000,
				};
				if (m.tool_calls) {
					try { msg.toolCalls = JSON.parse(m.tool_calls); } catch { /* */ }
				}
				return msg;
			});
			this._sessionId = sessionId;
			this._dbSessionId = sessionId;
			this._dbSessionCreated = true;
			this._dbSessionPromise = null;
			this._msgCounter = this._messages.length;
			this._currentAssistantMessage = null;
			this._persistedMessages.clear();
			for (const msg of this._messages) {
				this._persistedMessages.add(msg);
			}
			this._setStreaming(false);
			this._onDidChangeMessages.fire(this._messages);
		} catch { /* ignore */ }
	}

	async deleteSession(sessionId: string): Promise<void> {
		const invoke = SidexChatService._getTauriInvoke();
		if (!invoke) { return; }
		try {
			await invoke('session_delete', { sessionId });
			this._cachedSessions = this._cachedSessions.filter(s => s.id !== sessionId);
		} catch { /* ignore */ }
	}

	async pinSession(sessionId: string, pinned: boolean): Promise<void> {
		const invoke = SidexChatService._getTauriInvoke();
		if (!invoke) { return; }
		try {
			await invoke('session_pin', { sessionId, pinned });
			await this._refreshCachedSessions();
		} catch { /* ignore */ }
	}

	async archiveSession(sessionId: string, archived: boolean): Promise<void> {
		const invoke = SidexChatService._getTauriInvoke();
		if (!invoke) { return; }
		try {
			await invoke('session_archive', { sessionId, archived });
			await this._refreshCachedSessions();
		} catch { /* ignore */ }
	}

	async renameSession(sessionId: string, title: string): Promise<void> {
		const invoke = SidexChatService._getTauriInvoke();
		if (!invoke) { return; }
		try {
			await invoke('session_update_title', { sessionId, title });
			await this._refreshCachedSessions();
		} catch { /* ignore */ }
	}

	async searchSessions(query: string): Promise<Array<{ id: string; title: string; date: string; messageCount: number; pinned?: boolean; archived?: boolean }>> {
		const invoke = SidexChatService._getTauriInvoke();
		if (!invoke) { return []; }
		try {
			const ctx = this._gatherWorkspaceContext();
			const results = await invoke('session_search', { query, workspace: ctx.cwd }) as Array<{
				id: string; title: string; updated_at: number; message_count: number; pinned: boolean; archived: boolean;
			}>;
			return results
				.filter(s => !s.archived)
				.map(s => ({
					id: s.id,
					title: s.title,
					date: new Date(s.updated_at * 1000).toISOString(),
					messageCount: s.message_count,
					pinned: s.pinned,
					archived: s.archived,
				}));
		} catch { return []; }
	}

	private static _getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
		const g = globalThis as unknown as {
			__TAURI_INVOKE__?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
			__TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
		};
		return g.__TAURI_INVOKE__ ?? g.__TAURI_INTERNALS__?.invoke ?? null;
	}

	private _dbSessionPromise: Promise<void> | null = null;

	private _ensureDbSession(): Promise<void> {
		if (this._dbSessionCreated) { return Promise.resolve(); }
		if (this._dbSessionPromise) { return this._dbSessionPromise; }

		const invoke = SidexChatService._getTauriInvoke();
		if (!invoke) { return Promise.resolve(); }

		if (!this._dbSessionId) {
			this._dbSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		}
		const dbId = this._dbSessionId;

		const firstUserMsg = this._messages.find(m => m.role === 'user');
		const title = firstUserMsg
			? firstUserMsg.content.slice(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '')
			: 'Untitled';
		const ctx = this._gatherWorkspaceContext();

		this._dbSessionPromise = invoke('session_create', {
			id: dbId,
			title,
			model: this._serverModel,
			mode: this._currentMode,
			workspace: ctx.cwd,
		}).then(() => {
			this._dbSessionCreated = true;
			this._dbSessionPromise = null;
		}).catch(() => {
			this._dbSessionPromise = null;
		}) as Promise<void>;

		return this._dbSessionPromise;
	}

	private async _persistUserMessage(msg: IChatMessage): Promise<void> {
		const invoke = SidexChatService._getTauriInvoke();
		if (!invoke) { return; }

		try {
			await this._ensureDbSession();
			if (!this._dbSessionId) { return; }

			this._msgCounter++;
			await invoke('session_save_message', {
				id: `${this._dbSessionId}-msg-${this._msgCounter}`,
				sessionId: this._dbSessionId,
				role: msg.role,
				content: msg.content,
				toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
				toolCallId: null,
				createdAt: Math.floor(msg.timestamp / 1000),
			});
			this._persistedMessages.add(msg);
		} catch { /* persist failed silently */ }
	}

	private _persistAssistantMessage(msg: IChatMessage): void {
		if (this._persistedMessages.has(msg)) { return; }
		const invoke = SidexChatService._getTauriInvoke();
		if (!invoke) { return; }

		this._persistedMessages.add(msg);

		const doSave = () => {
			if (!this._dbSessionId) { return; }
			this._msgCounter++;
			const msgId = `${this._dbSessionId}-msg-${this._msgCounter}`;
			invoke('session_save_message', {
				id: msgId,
				sessionId: this._dbSessionId,
				role: msg.role,
				content: msg.content,
				toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
				toolCallId: null,
				createdAt: Math.floor(msg.timestamp / 1000),
			}).catch(() => { /* persist failed silently */ });
		};

		if (this._dbSessionCreated) {
			doSave();
		} else {
			this._ensureDbSession().then(() => doSave()).catch(() => { /* ignore */ });
		}
	}

	private _persistAllUnpersistedAssistantMessages(): void {
		for (const msg of this._messages) {
			if (msg.role === 'assistant' && !this._persistedMessages.has(msg)) {
				this._persistAssistantMessage(msg);
			}
		}
	}

	private async _refreshCachedSessions(): Promise<void> {
		const invoke = SidexChatService._getTauriInvoke();
		if (!invoke) { return; }
		try {
			const ctx = this._gatherWorkspaceContext();
			const sessions = await invoke('session_list', {
				workspace: ctx.cwd,
				limit: SidexChatService.MAX_SAVED_SESSIONS,
			}) as Array<{
				id: string; title: string; updated_at: number; message_count: number; pinned: boolean; archived: boolean;
			}>;
			this._cachedSessions = sessions
				.filter(s => !s.archived)
				.map(s => ({
					id: s.id,
					title: s.title,
					date: new Date(s.updated_at * 1000).toISOString(),
					messageCount: s.message_count,
					pinned: s.pinned,
					archived: s.archived,
				}));
		} catch { /* ignore */ }
	}

	stopStreaming(): void {
		this._currentAssistantMessage = null;
		this._setStreaming(false);
	}

	private async _handleLocalToolRequest(req: ILocalToolRequest): Promise<void> {
		// Intercept spawn_agents: run REAL subagents client-side with full tool access
		const AGENT_TOOLS = new Set([
			'spawn_agents', 'spawn_agent', 'subagent', 'delegate',
			'create_agent', 'parallel_agents',
		]);

		if (AGENT_TOOLS.has(req.name)) {
			const result = await this._runSubagents(req);
			if (this._ws && this._connectionState === 'connected') {
				this._ws.send(JSON.stringify(result));
			}
			this._refreshExplorerIfNeeded(req.name);
			return;
		}

		// Intercept ask_question: show UI widget and wait for user response
		if (req.name === 'ask_question') {
			try {
				const args = JSON.parse(req.arguments || '{}');
				const questions = args.questions || [args];
				for (const q of questions) {
					this._onDidReceiveChunk.fire({
						type: 'ask_question',
						question_id: q.id || req.tool_call_id,
						question_prompt: q.prompt || q.question || '',
						question_options: q.options || [],
						question_allow_multiple: q.allow_multiple || false,
						question_title: args.title || '',
						tool_call_id: req.tool_call_id,
					});
				}
			} catch { /* */ }
			// Response will be sent by the UI when user clicks an option
			return;
		}

		const resp = await this._localExecutor.execute(req);
		if (this._ws && this._connectionState === 'connected') {
			this._ws.send(JSON.stringify(resp));
		}

		// Update the tool call status locally (the server won't send tool_result back)
		if (this._currentAssistantMessage?.toolCalls) {
			const tc = this._currentAssistantMessage.toolCalls.find(t => t.id === req.tool_call_id);
			if (tc) {
				tc.output = resp.output || resp.error;
				tc.status = resp.error ? 'error' : 'done';
			}
		} else {
			// Tool call might be in a previous message
			for (let i = this._messages.length - 1; i >= 0; i--) {
				const msg = this._messages[i];
				if (msg.toolCalls) {
					const tc = msg.toolCalls.find(t => t.id === req.tool_call_id);
					if (tc) {
						tc.output = resp.output || resp.error;
						tc.status = resp.error ? 'error' : 'done';
						break;
					}
				}
			}
		}
		this._onDidChangeMessages.fire(this._messages);

		if (!resp.error) {
			this._refreshExplorerIfNeeded(req.name);
			this._emitCheckpointEvent(req.name, resp.output);
		}
	}

	private static readonly FS_MUTATING_TOOLS = new Set([
		'write_file', 'edit_file', 'multi_edit', 'delete_file',
		'shell', 'run_command', 'git_commit', 'git_checkout',
	]);

	private _refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	private _refreshExplorerIfNeeded(toolName: string): void {
		if (!SidexChatService.FS_MUTATING_TOOLS.has(toolName)) {
			return;
		}
		// Debounce: multiple rapid tool calls (e.g. subagent editing several files)
		// should coalesce into a single refresh
		if (this._refreshDebounceTimer) {
			clearTimeout(this._refreshDebounceTimer);
		}
		this._refreshDebounceTimer = setTimeout(() => {
			this._refreshDebounceTimer = null;
			this.explorerService.refresh().catch(() => { /* best effort */ });
		}, 300);
	}

	private _emitCheckpointEvent(toolName: string, output: string): void {
		if (toolName === 'checkpoint') {
			try {
				const result = JSON.parse(output);
				this._onDidReceiveChunk.fire({
					type: 'checkpoint_created',
					checkpoint_label: result.label || `checkpoint-${Date.now()}`,
					checkpoint_timestamp: (result.timestamp || Date.now() / 1000) * 1000,
					checkpoint_file_count: result.files_saved || 0,
					checkpoint_files: result.files || [],
				});
			} catch { /* malformed output */ }
		} else if (toolName === 'rollback') {
			try {
				const result = JSON.parse(output);
				this._onDidReceiveChunk.fire({
					type: 'checkpoint_restored',
					checkpoint_label: result.restored_to || result.label || '',
				});
			} catch { /* malformed output */ }
		}
	}

	/**
	 * Runs real subagents — each gets its own WebSocket to the server + full local tool access.
	 * This is how Cursor's Task tool works: subagents are parallel agent loops with full capabilities.
	 */
	private async _runSubagents(req: ILocalToolRequest): Promise<{ type: string; tool_call_id: string; output: string; error: string }> {
		let tasks: Array<{ description: string; prompt: string }> = [];

		try {
			const args = JSON.parse(req.arguments || '{}');
			// Handle different argument formats the server might use
			if (Array.isArray(args.tasks)) {
				tasks = args.tasks.map((t: { description?: string; prompt?: string; task?: string; goal?: string }) => ({
					description: t.description || t.task || 'subtask',
					prompt: t.prompt || t.goal || t.description || '',
				}));
			} else if (args.prompt || args.task || args.goal) {
				tasks = [{ description: args.description || 'subtask', prompt: args.prompt || args.task || args.goal }];
			} else if (typeof args === 'string') {
				tasks = [{ description: 'subtask', prompt: args }];
			}
		} catch {
			return {
				type: 'tool_response',
				tool_call_id: req.tool_call_id,
				output: '',
				error: 'Failed to parse subagent task arguments',
			};
		}

		if (tasks.length === 0) {
			return {
				type: 'tool_response',
				tool_call_id: req.tool_call_id,
				output: '',
				error: 'No tasks provided for subagents',
			};
		}

		// Run all subagent tasks in parallel
		const results = await Promise.all(
			tasks.map(task => this._runSingleSubagent(task.description, task.prompt))
		);

		const output = results.map((r, i) => {
			const header = `=== Subagent ${i + 1}: ${tasks[i].description} ===`;
			return `${header}\n${r.success ? r.output : `Error: ${r.error}`}`;
		}).join('\n\n');

		return {
			type: 'tool_response',
			tool_call_id: req.tool_call_id,
			output,
			error: '',
		};
	}

	/**
	 * Runs a single subagent: opens a new WebSocket, sends the task, handles tool_requests locally.
	 */
	/**
	 * Runs a typed subagent with tool restrictions based on its type.
	 */
	private _runTypedSubagent(
		agentId: string,
		type: SubagentType,
		description: string,
		prompt: string,
	): Promise<{ success: boolean; output: string; error: string; toolsUsed: string[] }> {
		const allowedTools = getAllowedTools(type);
		const message = buildSubagentPrompt(type, prompt);

		return new Promise((resolve) => {
			const wsUrl = this._buildStreamUrl();
			let ws: WebSocket;

			try {
				ws = new WebSocket(wsUrl);
			} catch {
				resolve({ success: false, output: '', error: 'Failed to connect', toolsUsed: [] });
				return;
			}

			let content = '';
			let settled = false;
			const toolsUsed: string[] = [];
			const ctx = this._gatherWorkspaceContext();

			const finish = (success: boolean, error = '') => {
				if (settled) { return; }
				settled = true;
				try { ws.close(); } catch { /* */ }
				resolve({ success, output: content, error, toolsUsed });
			};

			const timer = setTimeout(() => finish(true), 120000);

			ws.onopen = () => {
				ws.send(JSON.stringify({
					session_id: `${agentId}`,
					message,
					mode: 'agent',
					model: this._serverModel,
					permission_mode: 'auto_all',
					cwd: ctx.cwd,
					local_exec: true,
					tool_execution: 'local',
					context: {
						workspace_folders: ctx.workspaceFolders,
						active_file: ctx.activeFile,
					},
				}));
			};

			ws.onmessage = async (event) => {
				try {
					const chunk = JSON.parse(event.data);
					switch (chunk.type) {
						case 'text':
							content += chunk.content || '';
							break;
						case 'tool_request': {
							const toolName = chunk.name;

							// Enforce tool restrictions based on subagent type
							if (!allowedTools.has(toolName)) {
								ws.send(JSON.stringify({
									type: 'tool_response',
									tool_call_id: chunk.tool_call_id,
									output: '',
									error: `Tool "${toolName}" is not available for ${type} agents. Available: ${[...allowedTools].join(', ')}`,
								}));
								break;
							}

							// Handle nested subagent spawning (generalPurpose can call 'task')
							if (toolName === 'task') {
								try {
									const taskArgs = JSON.parse(chunk.arguments || '{}');
									const subType = (taskArgs.subagent_type || taskArgs.type || 'explore') as SubagentType;
									const subPrompt = taskArgs.prompt || taskArgs.task || '';
									const subDesc = taskArgs.description || 'sub-subtask';
									const subId = `sub-${agentId}-${Date.now()}`;

									const subResult = await this._runTypedSubagent(subId, subType, subDesc, subPrompt);
									ws.send(JSON.stringify({
										type: 'tool_response',
										tool_call_id: chunk.tool_call_id,
										output: subResult.output || '(no output)',
										error: subResult.error || '',
									}));
								} catch (e) {
									ws.send(JSON.stringify({
										type: 'tool_response',
										tool_call_id: chunk.tool_call_id,
										output: '',
										error: `Sub-subagent failed: ${(e as Error).message}`,
									}));
								}
								break;
							}

							toolsUsed.push(toolName);
							const resp = await this._localExecutor.execute({
								type: 'tool_request',
								tool_call_id: chunk.tool_call_id,
								name: toolName,
								arguments: chunk.arguments || '{}',
							});
							if (!settled) {
								ws.send(JSON.stringify(resp));
							}
							if (!resp.error) {
								this._refreshExplorerIfNeeded(toolName);
							}

							// Emit tool update for UI
							this._onDidReceiveChunk.fire({
								type: 'subagent_update',
								subagent_id: agentId,
								subagent_tools: toolsUsed.map(n => ({ name: n, status: 'done' })),
							});
							break;
						}
						case 'done':
						case 'turn_complete':
							clearTimeout(timer);
							finish(true);
							break;
						case 'error':
							clearTimeout(timer);
							finish(false, chunk.error || chunk.content || 'Unknown error');
							break;
					}
				} catch { /* ignore */ }
			};

			ws.onerror = () => { clearTimeout(timer); finish(false, 'WebSocket error'); };
			ws.onclose = () => { clearTimeout(timer); if (!settled) { finish(true); } };
		});
	}

	private _runSingleSubagent(description: string, prompt: string): Promise<{ success: boolean; output: string; error: string }> {
		return new Promise((resolve) => {
			const wsUrl = this._buildStreamUrl();
			let ws: WebSocket;

			try {
				ws = new WebSocket(wsUrl);
			} catch {
				resolve({ success: false, output: '', error: 'Failed to connect' });
				return;
			}

			let content = '';
			let settled = false;
			const ctx = this._gatherWorkspaceContext();

			const finish = (success: boolean, error = '') => {
				if (settled) { return; }
				settled = true;
				try { ws.close(); } catch { /* */ }
				resolve({ success, output: content, error });
			};

			// Timeout after 2 minutes
			const timer = setTimeout(() => finish(true), 120000);

			ws.onopen = () => {
				const payload = {
					session_id: `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
					message: `Complete this task directly using tools. Do not use spawn_agents.

Task: ${description}
${prompt}`,
					mode: 'agent',
					model: this._serverModel,
					permission_mode: 'auto_all',
					cwd: ctx.cwd,
					local_exec: true,
					disabled_tools: ['spawn_agents', 'spawn_agent', 'subagent'],
					tool_execution: 'local',
					context: {
						workspace_folders: ctx.workspaceFolders,
						active_file: ctx.activeFile,
					},
				};
				ws.send(JSON.stringify(payload));
			};

			ws.onmessage = async (event) => {
				try {
					const chunk = JSON.parse(event.data);
					switch (chunk.type) {
						case 'text':
							content += chunk.content || '';
							break;
						case 'tool_request': {
							// Execute tool locally via Tauri — subagent has full access!
							const resp = await this._localExecutor.execute({
								type: 'tool_request',
								tool_call_id: chunk.tool_call_id,
								name: chunk.name,
								arguments: chunk.arguments || '{}',
							});
							if (!settled) {
								ws.send(JSON.stringify(resp));
							}
							if (!resp.error) {
								this._refreshExplorerIfNeeded(chunk.name);
							}
							// Surface tool calls in main chat UI
							if (this._currentAssistantMessage) {
								this._currentAssistantMessage.toolCalls!.push({
									id: chunk.tool_call_id,
									name: chunk.name,
									input: chunk.arguments || '',
									status: 'running',
								});
								this._onDidChangeMessages.fire(this._messages);
								// Mark done after a short delay
								setTimeout(() => {
									const tc = this._currentAssistantMessage?.toolCalls?.find(
										t => t.id === chunk.tool_call_id
									);
									if (tc) {
										tc.status = 'done';
										tc.output = resp.output?.slice(0, 200);
										this._onDidChangeMessages.fire(this._messages);
									}
								}, 100);
							}
							break;
						}
						case 'done':
						case 'turn_complete':
							clearTimeout(timer);
							finish(true);
							break;
						case 'error':
							clearTimeout(timer);
							finish(false, chunk.error || chunk.content || 'Unknown error');
							break;
					}
				} catch { /* ignore */ }
			};

			ws.onerror = () => {
				clearTimeout(timer);
				finish(false, 'WebSocket error');
			};

			ws.onclose = () => {
				clearTimeout(timer);
				if (!settled) { finish(true); }
			};
		});
	}

	/**
	 * Intercepts spawn_agents tool_call — runs real subagents locally and sends result back to server.
	 */
	private async _interceptSpawnAgents(toolCallId: string, argsJson: string): Promise<void> {
		// Full Cursor-style Task tool interface
		interface TaskArgs {
			description?: string;
			prompt?: string;
			task?: string;
			goal?: string;
			subagent_type?: string;
			type?: string;
			run_in_background?: boolean;
			model?: string;
			resume?: string;
			interrupt?: boolean;
			readonly?: boolean;
			tasks?: TaskArgs[];
		}

		let taskList: TaskArgs[] = [];
		try {
			const args: TaskArgs = JSON.parse(argsJson || '{}');
			if (Array.isArray(args.tasks)) {
				taskList = args.tasks;
			} else {
				taskList = [args];
			}
		} catch { /* */ }

		if (taskList.length === 0 || (!taskList[0].prompt && !taskList[0].task && !taskList[0].goal)) {
			if (this._ws && this._connectionState === 'connected') {
				this._ws.send(JSON.stringify({ type: 'tool_response', tool_call_id: toolCallId, output: '', error: 'No tasks provided. Pass { prompt, description, subagent_type }.' }));
			}
			return;
		}

		const subagentIds: string[] = [];
		const promises: Promise<{ success: boolean; output: string; toolsUsed: string[]; error: string }>[] = [];

		for (const task of taskList) {
			const description = task.description || 'subtask';
			const prompt = task.prompt || task.task || task.goal || '';
			let type = (task.subagent_type || task.type || 'generalPurpose') as SubagentType;
			const model = task.model || this._serverModel;
			const isReadonly = task.readonly || false;
			const resumeId = task.resume;

			// Validate type
			if (!SUBAGENT_CONFIGS[type]) { type = 'generalPurpose'; }
			// Force readonly if specified
			if (isReadonly && type === 'generalPurpose') { type = 'explore'; }

			// RESUME: continue a previous agent's conversation
			if (resumeId && resumeId !== 'self') {
				const canResume = this._subagentRegistry.canResume(resumeId);
				if (canResume) {
					const prev = this._subagentRegistry.get(resumeId)!;
					// Re-register as running
					this._subagentRegistry.update(resumeId, { status: 'running', completedAt: null });
					subagentIds.push(resumeId);

					this._onDidReceiveChunk.fire({
						type: 'subagent_spawned',
						subagent_id: resumeId,
						subagent_description: `${prev.description} (resumed)`,
						subagent_model: model,
						subagent_status: 'running',
						subagent_prompt: prompt,
					});

					// Resume = send follow-up prompt to same session
					const resumePrompt = `${prev.conversationHistory.map(m => `[${m.role}]: ${m.content}`).join('\n')}\n\n[user]: ${prompt}`;
					promises.push(this._runTypedSubagent(resumeId, prev.type, prev.description, resumePrompt));
					continue;
				}
			}

			// NEW AGENT
			const id = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			subagentIds.push(id);

			this._subagentRegistry.register({
				id,
				type,
				description,
				status: 'running',
				output: '',
				toolsUsed: [],
				startedAt: Date.now(),
				completedAt: null,
				model,
				conversationHistory: [{ role: 'user', content: prompt }],
				parentId: null,
			});

			this._onDidReceiveChunk.fire({
				type: 'subagent_spawned',
				subagent_id: id,
				subagent_description: description,
				subagent_model: model,
				subagent_status: 'running',
				subagent_prompt: prompt,
			});

			promises.push(this._runTypedSubagent(id, type, description, prompt));
		}

		// Run all in parallel
		const results = await Promise.all(
			promises.map((p, i) => p.then(r => {
				const agentId = subagentIds[i];
				this._subagentRegistry.update(agentId, {
					status: r.success ? 'completed' : 'failed',
					output: r.output,
					toolsUsed: r.toolsUsed || [],
					completedAt: Date.now(),
					conversationHistory: [
						...(this._subagentRegistry.get(agentId)?.conversationHistory || []),
						{ role: 'assistant', content: r.output },
					],
				});
				this._onDidReceiveChunk.fire({
					type: 'subagent_complete',
					subagent_id: agentId,
					subagent_status: r.success ? 'completed' : 'failed',
					subagent_output: r.output.slice(0, 500),
					subagent_tools: (r.toolsUsed || []).map((name: string) => ({ name, status: 'done' })),
				});
				return r;
			}))
		);

		const output = results.map((r, i) => {
			const desc = this._subagentRegistry.get(subagentIds[i])?.description || `Task ${i + 1}`;
			const type = this._subagentRegistry.get(subagentIds[i])?.type || 'generalPurpose';
			return `=== ${desc} (${type}) ===\n${r.success ? r.output : `Error: ${r.error}`}`;
		}).join('\n\n');

		// Mark tool call done in UI
		if (this._currentAssistantMessage?.toolCalls) {
			const tc = this._currentAssistantMessage.toolCalls.find(t => t.id === toolCallId);
			if (tc) {
				tc.status = 'done';
				tc.output = `${results.length} subagents completed`;
				this._onDidChangeMessages.fire(this._messages);
			}
		}

		// Send combined result back to server
		if (this._ws && this._connectionState === 'connected') {
			this._ws.send(JSON.stringify({ type: 'tool_response', tool_call_id: toolCallId, output, error: '' }));
		}
	}

	private _handleChunk(chunk: IStreamChunk): void {
		this._onDidReceiveChunk.fire(chunk);

		switch (chunk.type) {
			case 'session':
				if (chunk.content) {
					this._sessionId = chunk.content;
				}
				break;

			case 'text':
				if (!this._currentAssistantMessage) {
					this._currentAssistantMessage = {
						role: 'assistant',
						content: '',
						toolCalls: [],
						timestamp: Date.now(),
					};
					this._messages.push(this._currentAssistantMessage);
				}
				this._currentAssistantMessage.content += chunk.content || '';
				this._onDidChangeMessages.fire(this._messages);
				break;

			case 'tool_call':
				if (!this._currentAssistantMessage) {
					this._currentAssistantMessage = {
						role: 'assistant',
						content: '',
						toolCalls: [],
						timestamp: Date.now(),
					};
					this._messages.push(this._currentAssistantMessage);
				}
				if (chunk.tool_calls) {
					for (const tc of chunk.tool_calls) {
						// Agent file edits make the semantic index stale —
						// schedule an incremental re-sync after this turn ends.
						if (SidexChatService.EDIT_TOOLS.has(tc.function.name)) {
							this._indexDirty = true;
						}
						// Intercept spawn_agents: run real subagents locally with full tool access
						if (tc.function.name === 'spawn_agents' || tc.function.name === 'spawn_agent') {
							this._currentAssistantMessage.toolCalls!.push({
								id: tc.id,
								name: tc.function.name,
								input: tc.function.arguments,
								status: 'running',
							});
							this._onDidChangeMessages.fire(this._messages);
							// Server handles subagents now — cards created via subagent_running chunks
							continue;
						}
						this._currentAssistantMessage.toolCalls!.push({
							id: tc.id,
							name: tc.function.name,
							input: tc.function.arguments,
							status: 'running',
						});
					}
				}
				this._onDidChangeMessages.fire(this._messages);
				break;

			case 'tool_result':
				if (chunk.tool_call_id) {
					// Search all messages for the tool call (it may be in a prior message)
					let found = false;
					if (this._currentAssistantMessage?.toolCalls) {
						const tc = this._currentAssistantMessage.toolCalls.find(t => t.id === chunk.tool_call_id);
						if (tc) {
							tc.output = chunk.content;
							tc.status = 'done';
							found = true;
						}
					}
					if (!found) {
						for (let i = this._messages.length - 1; i >= 0; i--) {
							const msg = this._messages[i];
							if (msg.toolCalls) {
								const tc = msg.toolCalls.find(t => t.id === chunk.tool_call_id);
								if (tc) {
									tc.output = chunk.content;
									tc.status = 'done';
									found = true;
									break;
								}
							}
						}
					}
				}
				this._onDidChangeMessages.fire(this._messages);
				break;

			case 'thinking':
			if (!this._currentAssistantMessage) {
				this._currentAssistantMessage = {
					role: 'assistant',
					content: '',
					thinkingContent: '',
					toolCalls: [],
					timestamp: Date.now(),
				};
				this._messages.push(this._currentAssistantMessage);
			}
			if (this._currentAssistantMessage.thinkingContent === undefined) {
				this._currentAssistantMessage.thinkingContent = '';
			}
			this._currentAssistantMessage.thinkingContent += chunk.content || '';
			this._isThinking = true;
			this._onDidChangeMessages.fire(this._messages);
			break;

		case 'thinking_done':
			this._isThinking = false;
			break;

		case 'done':
				if (this._currentAssistantMessage) {
					this._persistAssistantMessage(this._currentAssistantMessage);
				}
				this._currentAssistantMessage = null;
				this._setStreaming(false);
				this._persistAllUnpersistedAssistantMessages();
				this._onDidChangeMessages.fire(this._messages);
				// The agent edited files this turn — refresh the index
				// (debounced; Merkle root-hash short-circuits no-op syncs).
				if (this._indexDirty) {
					this._indexDirty = false;
					this._scheduleReindex();
				}
				break;

			case 'error':
				// Don't pollute the chat with error messages — emit a separate event
				// so the view can show it as a dismissible banner above the input.
				this._onDidReceiveChunk.fire({ type: 'error', content: chunk.error || 'An unexpected error occurred.' } as IStreamChunk);
				if (this._currentAssistantMessage) {
					this._persistAssistantMessage(this._currentAssistantMessage);
					this._currentAssistantMessage = null;
				}
				this._setStreaming(false);
				this._onDidChangeMessages.fire(this._messages);
				break;

			case 'mode_change':
				if (chunk.mode) {
					this._currentMode = chunk.mode as AgentMode;
				}
				break;

			case 'cost_update':
			case 'cost_summary':
				if (typeof chunk.total_cost === 'number') {
					this._sessionCost = chunk.total_cost;
				}
				const fromSummary = chunk.total_input_tokens
					?? chunk.usage?.input_tokens
					?? 0;
				if (fromSummary > 0) {
					this._lastPromptTokens = fromSummary;
				}
				this._onDidChangeMessages.fire(this._messages);
				break;
			case 'brief':
			case 'tick':
			case 'notice':
			case 'permission_request':
				break;
			case 'usage': {
				const used = chunk.tokens_used;
				const prompt = used?.prompt_tokens ?? chunk.usage?.input_tokens ?? 0;
				if (prompt > 0) {
					this._lastPromptTokens = prompt;
					this._onDidChangeMessages.fire(this._messages);
				}
				break;
			}

			// Server-side subagent progress events → emit as subagent_spawned/update/complete for UI
			case 'subagent_start':
			case 'subagent_running':
			case 'subagent_done': {
				const content = chunk.content || '';
				// Parse "[agent_id] (type) description" format
				const match = content.match(/\[([^\]]+)\]\s*(?:\(([^)]+)\))?\s*(.*)/);
				if (match) {
					const agentId = match[1];
					const description = match[3] || content;

					if (chunk.type === 'subagent_running') {
						this._onDidReceiveChunk.fire({
							type: 'subagent_spawned',
							subagent_id: agentId,
							subagent_description: description,
							subagent_model: this._serverModel,
							subagent_status: 'running',
							subagent_prompt: description,
						});
					} else if (chunk.type === 'subagent_done') {
						const status = content.includes('failed') ? 'failed' : 'completed';
						this._onDidReceiveChunk.fire({
							type: 'subagent_complete',
							subagent_id: agentId,
							subagent_status: status as 'completed' | 'failed',
							subagent_output: description,
						});
					}
				}
				break;
			}

			case 'turn_complete':
				if (this._currentAssistantMessage) {
					this._persistAssistantMessage(this._currentAssistantMessage);
					this._currentAssistantMessage = null;
				}
				break;
		}
	}

	private _setConnectionState(state: ConnectionState): void {
		if (this._connectionState !== state) {
			this._connectionState = state;
			this._onDidChangeConnectionState.fire(state);
		}
	}

	private _setStreaming(streaming: boolean): void {
		if (this._isStreaming !== streaming) {
			this._isStreaming = streaming;
			this._onDidChangeStreaming.fire(streaming);
		}
	}

	private _scheduleReconnect(): void {
		if (this._reconnectAttempts >= 10) {
			return;
		}
		// Ensure we don't start multiple reconnect timers
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
		this._reconnectAttempts++;
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			this.connect();
		}, delay);
	}

	override dispose(): void {
		if (this._reindexTimer) { clearTimeout(this._reindexTimer); }
		if (this._reindexInterval) { clearInterval(this._reindexInterval); }
		this.disconnect();
		super.dispose();
	}

	private _triggerContextIndex(): void {
		if (!LOCAL_TOOLS_SUPPORTED() || this._contextIndexed || this._contextIndexing) {
			return;
		}
		// No folder open (welcome screen / fresh launch) — nothing to index.
		// The constructor's workspace-folder listener retries when one opens.
		const wsPath = this.workspacePath;
		if (!wsPath || wsPath === '.' || wsPath === '/') {
			return;
		}
		this._contextIndexing = true;

		this._localExecutor.execute({
			type: 'tool_request',
			tool_call_id: `ctx-index-${Date.now()}`,
			name: 'context_index',
			arguments: '{}',
		}).then(result => {
			if (!result.error) {
				this._contextIndexed = true;
				this._startFileWatcher();
			} else {
				// Background feature: log, don't alarm the user with a popup.
				// context_search degrades gracefully to grep when unavailable.
				console.warn('[sidex-index] local index unavailable:', result.error);
			}
		}).catch(err => {
			console.warn('[sidex-index] local index unavailable:', err);
		}).finally(() => {
			this._contextIndexing = false;
		});
	}

	private _triggerAutoIndex(): void {
		const invoke = SidexChatService._getTauriInvoke();
		const wsPath = this.workspacePath;
		if (!invoke || !wsPath || wsPath === '.') { return; }

		// autoIndex defaults ON (like Cursor). The local BM25 index always
		// builds — it powers the files count and local search; the CLOUD
		// upload additionally requires sign-in and the setting not being off.
		invoke('settings_get', { section: 'sidex.indexing.autoIndex' }).then(raw => {
			const autoIndexOff = raw === false || raw === 'false';

			window.dispatchEvent(new CustomEvent('sidex-indexing-status', {
				detail: { status: 'indexing', path: wsPath }
			}));

			invoke('index_build', { root: wsPath }).then(() => {
				if (!autoIndexOff) {
					// Keep the index fresh: periodic incremental
					// re-sync (Merkle diff makes unchanged syncs ~free).
					this._startReindexInterval();
				}
			}).catch(err => {
				console.error('[sidex-index] index build failed:', err);
				window.dispatchEvent(new CustomEvent('sidex-indexing-status', {
					detail: { status: 'error', path: wsPath, error: err }
				}));
			});
		}).catch(() => {
			// Setting store unavailable — still build the local index.
			invoke('index_build', { root: wsPath }).catch(() => { /* logged in Rust */ });
		});
	}

	/** Debounced incremental re-index (after agent edits). */
	private _scheduleReindex(): void {
		if (this._reindexTimer) { clearTimeout(this._reindexTimer); }
		this._reindexTimer = setTimeout(() => {
			this._reindexTimer = undefined;
			this._runReindex();
		}, 15_000);
	}

	/** Periodic catch-all re-index for edits made outside the agent. */
	private _startReindexInterval(): void {
		if (this._reindexInterval) { return; }
		this._reindexInterval = setInterval(() => this._runReindex(), 5 * 60_000);
	}

	private _runReindex(): void {
		const invoke = SidexChatService._getTauriInvoke();
		const wsPath = this.workspacePath;
		if (!invoke || !wsPath || wsPath === '.') { return; }
		invoke('index_build', { root: wsPath }).catch(() => {
			// Non-fatal: the next interval/edit will retry.
		});
	}

	private _startFileWatcher(): void {
		if (!LOCAL_TOOLS_SUPPORTED() || !this._contextIndexed) {
			return;
		}
		this._localExecutor.execute({
			type: 'tool_request',
			tool_call_id: `ctx-watch-${Date.now()}`,
			name: 'context_watch',
			arguments: '{}',
		}).catch(() => {
			// File watcher failed to start — incremental indexing unavailable
		});
	}

	/** Re-fetch and re-filter the model list. Call after toggling models in Settings. */
	refreshModels(): void {
		// _fetchServerInfo uses plain HTTP (not the WS), so it works even when
		// the chat socket is disconnected — toggling models in Settings must
		// never be silently dropped.
		this._fetchServerInfo();
	}

	private _fetchOsInfo(): void {
		const invoke = (globalThis as { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } }).__TAURI_INTERNALS__?.invoke;
		if (!invoke) { return; }
		invoke('get_os_info').then((info: unknown) => {
			const os = info as { platform?: string; arch?: string; hostname?: string };
			if (os) {
				const shell = os.platform === 'windows' ? 'powershell' : 'zsh';
				// Format like Cursor: "darwin 25.4.0" or "win32 10.0.22000"
				const platformStr = os.platform === 'macos'
					? `macOS (Apple Silicon)` // aarch64 = Apple Silicon
					: os.platform === 'windows'
						? `Windows (${os.arch})`
						: `Linux (${os.arch})`;
				this._osInfo = {
					platform: platformStr,
					arch: os.arch || 'unknown',
					shell,
				};
			}
		}).catch(() => { /* not critical */ });
	}

	private _fetchServerInfo(): void {
		// The port is only known once the supervisor reports it; fetching before
		// then goes to the default port and fails.
		void resolveServerEndpoint().then(() => this._doFetchServerInfo());
	}

	private _doFetchServerInfo(): void {
		// Restore saved model or use default
		try {
			const saved = localStorage.getItem(SidexChatService.MODEL_STORAGE_KEY);
			if (saved) {
				this._serverModel = saved;
			}
		} catch { /* */ }
		if (!this._serverModel) {
			this._serverModel = SidexChatService.DEFAULT_MODEL;
		}

		const httpUrl = this._serverUrl.replace(/^ws/, 'http');
		const tauriInvoke = (globalThis as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__?.invoke;

		Promise.all([
			fetch(httpUrl + '/v1/models').then(r => r.json()).catch(() => []),
			tauriInvoke
				? tauriInvoke('settings_get', { section: 'sidex.models.enabled' })
					.then(raw => {
						if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
						return raw;
					})
					.catch(() => null)
				: Promise.resolve(null),
			tauriInvoke
				? tauriInvoke('settings_get', { section: 'sidex.models.custom' })
					.then(raw => {
						if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
						return raw;
					})
					.catch(() => null)
				: Promise.resolve(null),
			tauriInvoke
				? tauriInvoke('settings_get', { section: 'sidex.general' })
					.then(raw => {
						if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
						return raw;
					})
					.catch(() => null)
				: Promise.resolve(null),
		]).then(([allModels, enabledRaw, customRaw, generalRaw]) => {
			if (!Array.isArray(allModels)) { return; }

			let defaultModelId = SidexChatService.DEFAULT_MODEL;
			if (generalRaw && typeof generalRaw === 'object') {
				const g = generalRaw as Record<string, unknown>;
				if (typeof g.defaultModel === 'string' && g.defaultModel.trim()) {
					defaultModelId = g.defaultModel.trim();
				}
			}
			if (defaultModelId) {
				SidexChatService.DEFAULT_MODEL = defaultModelId;
				const saved = localStorage.getItem(SidexChatService.MODEL_STORAGE_KEY);
				if (!saved) {
					this._serverModel = defaultModelId;
				}
			}

			let models = (allModels as Array<{ id: string; name: string; provider: string; default?: boolean; context_window?: number; contextWindow?: number }>).map(m => ({
				id: m.id,
				name: m.name,
				provider: m.provider,
				contextWindow: m.contextWindow || m.context_window || contextWindowForModel(m.id),
			}));

			// Custom models (arbitrary OpenRouter IDs added in Settings) are
			// first-class: append any that aren't already in the server list.
			if (Array.isArray(customRaw)) {
				for (const entry of customRaw as Array<string | { id?: string; name?: string }>) {
					const id = typeof entry === 'string' ? entry : entry?.id;
					if (id && !models.find(m => m.id === id)) {
						const name = typeof entry === 'object' && entry?.name ? entry.name : id;
						models = [...models, { id, name, provider: 'custom' }];
					}
				}
			}

			// The server list is live from each connected provider (Claude,
			// Codex, Ollama, …). Do not filter it down to a hardcoded ID
			// allowlist — that hides new snapshots the moment a provider
			// ships them. Custom IDs the user typed are already merged above.
			this._availableModels = models;
			this._onDidChangeModels.fire(this._availableModels);

		// Keep the user's pick when it is still in the live list. Anthropic
		// returns Opus first; blindly adopting that on every fetch is how a
		// connected Claude login ends up on a model the current window has
		// already exhausted.
		const effective = this._availableModels;
		const stillOffered = effective.some(m => m.id === this._serverModel);
		if (!stillOffered && effective.length > 0) {
			const preferred = effective.find(m => /sonnet/i.test(m.id))
				|| effective.find(m => /haiku/i.test(m.id))
				|| effective[0];
			this._serverModel = preferred.id;
			try { localStorage.setItem(SidexChatService.MODEL_STORAGE_KEY, this._serverModel); } catch { /* */ }
		}
		});
	}
}

export function contextWindowForModel(modelId: string): number {
	const id = (modelId || '').toLowerCase();
	if (id.includes('gemini') || id.includes('fable') || id.includes('mythos') || id.includes('gpt-4.1')) {
		return 1_000_000;
	}
	if (id.includes('gpt-4o')) {
		return 128_000;
	}
	if (id.includes('gpt-5') || id.includes('codex')) {
		return 400_000;
	}
	if (id.includes('1m') && id.includes('claude')) {
		return 1_000_000;
	}
	return 200_000;
}

registerSingleton(ISidexChatService, SidexChatService, InstantiationType.Delayed);
