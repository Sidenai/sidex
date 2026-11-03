/*---------------------------------------------------------------------------------------------
 *  Sidex Chat View — Composes component classes into the chat panel
 *--------------------------------------------------------------------------------------------*/

import './media/sidexChatView.css';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import * as DOM from '../../../../base/browser/dom.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ISidexChatService, IChatMessage } from './sidexChatService.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ChatHeader } from './components/toolbar/chatHeader.js';
import { ChatInput } from './components/input/chatInput.js';
import { UserMessage } from './components/messages/userMessage.js';
import { AssistantMessage } from './components/messages/assistantMessage.js';
import { renderMarkdown } from './components/markdownRenderer.js';
import { PermissionRequestDialog, PermissionRequestData } from './components/messages/permissionRequest.js';
import { QuestionDialog } from './components/messages/questionDialog.js';
import { SubagentCard, SubagentInfo } from './components/messages/subagentCard.js';
import { SidexOrchestrator, OrchestrationView, StreamConsumer } from './orchestrator/index.js';
import { IAccountService } from './account/accountService.js';
import { AccountPanel } from './account/accountPanel.js';
import { serverWsUrl } from './localServer.js';

const $ = DOM.$;

export class SidexChatViewPane extends ViewPane {
	private _header!: ChatHeader;
	private _accountPanel!: AccountPanel;
	private _messagesEl!: HTMLElement;
	private _welcomeEl!: HTMLElement;
	private _input!: ChatInput;
	private _turnStartTime = 0;
	private _noticeTimer: ReturnType<typeof setTimeout> | null = null;
	private _lastDiffRebuildEditCount = 0;
	private readonly _viewDisposables = this._register(new DisposableStore());

	private _userHasScrolledUp = false;
	private _renderPending = false;
	private _pendingMessages: readonly IChatMessage[] = [];
	private _renderedMessageCount = 0;
	private _orchestrator: SidexOrchestrator | null = null;
	private _orchView: OrchestrationView | null = null;
	private _orchStream: StreamConsumer | null = null;
	private _subagentCards: Map<string, SubagentCard> = new Map();
	private _redoLinkEl: HTMLElement | null = null;
	private _revertedContainer: HTMLElement | null = null;
	private _autoScrollValue = true;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISidexChatService private readonly chatService: ISidexChatService,
		@IEditorService private readonly editorService: IEditorService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IModelService private readonly modelService: IModelService,
		@IAccountService private readonly accountService: IAccountService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		parent.classList.add('sidex-chat-view');
		this._blockPanelFileDropsOutsideInput(parent);

		// Header — pass accountService so it renders the live account button
		this._header = new ChatHeader(this.accountService);
		this._header.appendTo(parent);
		this._viewDisposables.add(this._header);

		// Account panel — floating dropdown, appended to parent so it overlays messages
		this._accountPanel = new AccountPanel(this.accountService);
		this._accountPanel.appendTo(parent);
		this._viewDisposables.add(this._accountPanel);

		this._messagesEl = DOM.append(parent, $('div.sc-messages'));

		// Force trackpad/mouse wheel scrolling — ViewPane can intercept wheel events
		this._messagesEl.addEventListener('wheel', (e) => {
			this._messagesEl.scrollTop += e.deltaY;
			e.stopPropagation();
		}, { passive: false });

		this._welcomeEl = DOM.append(this._messagesEl, $('div.sc-welcome'));

		const logoSvg = `<svg class="sc-welcome-logo" viewBox="0 0 150 150" fill="none" xmlns="http://www.w3.org/2000/svg">
<defs>
  <clipPath id="sx_holes">
    <path d="M0 0h150v150H0z M37.5 62.5h25v25h-25z M87.5 62.5h25v25h-25z" clip-rule="evenodd"/>
  </clipPath>
</defs>
<g clip-path="url(#sx_holes)">
  <rect x="0" y="0" width="50" height="50" fill="currentColor"/>
  <rect x="100" y="0" width="50" height="50" fill="currentColor"/>
  <rect x="25" y="50" width="50" height="50" fill="currentColor"/>
  <rect x="75" y="50" width="50" height="50" fill="currentColor"/>
  <rect x="50" y="100" width="50" height="50" fill="currentColor"/>
</g>
</svg>`;

		this._welcomeEl.innerHTML = logoSvg;

		this._input = new ChatInput(this.chatService);
		this._input.appendTo(parent);
		this._viewDisposables.add(this._input);

		this._bindScrollDetection();
		this._bindEvents();
		this.chatService.connect();

		// Fetch autoScroll setting from settings
		const tInvoke = (globalThis as any).__TAURI_INTERNALS__?.invoke;
		if (tInvoke) {
			tInvoke('settings_get', { section: 'sidex.general' }).then(raw => {
				let data: any = raw;
				if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch { return; } }
				if (data && typeof data === 'object' && data.autoScroll !== undefined) {
					this._autoScrollValue = !!data.autoScroll;
				}
			}).catch(() => {});
		}

		// Update on changed event
		const onSettingsChanged = () => {
			if (tInvoke) {
				tInvoke('settings_get', { section: 'sidex.general' }).then(raw => {
					let data: any = raw;
					if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch { return; } }
					if (data && typeof data === 'object' && data.autoScroll !== undefined) {
						this._autoScrollValue = !!data.autoScroll;
					}
				}).catch(() => {});
			}
		};
		window.addEventListener('sidex-settings-changed', onSettingsChanged);
		this._viewDisposables.add({ dispose: () => window.removeEventListener('sidex-settings-changed', onSettingsChanged) });
	}

	private _blockPanelFileDropsOutsideInput(parent: HTMLElement): void {
		const shouldBlock = (event: DragEvent): boolean => {
			if (!this._dragEventHasFiles(event)) {
				return false;
			}
			const target = event.target as HTMLElement | null;
			return !target?.closest('.sc-input-area');
		};
		const block = (event: DragEvent) => {
			if (!shouldBlock(event)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = 'none';
			}
		};
		parent.addEventListener('dragenter', block, true);
		parent.addEventListener('dragover', block, true);
		parent.addEventListener('drop', block, true);
		this._viewDisposables.add({
			dispose: () => {
				parent.removeEventListener('dragenter', block, true);
				parent.removeEventListener('dragover', block, true);
				parent.removeEventListener('drop', block, true);
			}
		});
	}

	private _dragEventHasFiles(event: DragEvent): boolean {
		const transfer = event.dataTransfer;
		if (!transfer) {
			return false;
		}
		if (transfer.files.length > 0) {
			return true;
		}
		return Array.from(transfer.types).includes('Files');
	}

	private _bindScrollDetection(): void {
		const threshold = 50;
		this._messagesEl.addEventListener('scroll', () => {
			const distanceFromBottom = this._messagesEl.scrollHeight
				- this._messagesEl.scrollTop
				- this._messagesEl.clientHeight;
			this._userHasScrolledUp = distanceFromBottom > threshold;
		});
	}

	private _bindEvents(): void {
		this._viewDisposables.add(this._input.onSend(text => {
			if (text.startsWith('/orchestrate ')) {
				this._startOrchestration(text.slice('/orchestrate '.length));
				return;
			}
			this._turnStartTime = Date.now();
			this._userHasScrolledUp = false;
			this._lastDiffRebuildEditCount = 0;
			this.chatService.sendMessage(text);
		}));
		this._viewDisposables.add(this._input.onStop(() => this.chatService.stopStreaming()));
		this._viewDisposables.add(this._input.onModeChange(mode => this.chatService.setMode(mode)));
		this._viewDisposables.add(this._input.onMaxModeChange(on => this.chatService.setMaxMode(on)));
		this._viewDisposables.add(this._input.onThinkingBudgetChange(budget => {
			this.chatService.setThinkingBudget(budget);
			this.chatService.setThinkingEffort(this._input.thinkingEffort);
		}));
		this.chatService.setMaxMode(this._input.maxMode);
		this.chatService.setThinkingBudget(this._input.thinkingBudget);
		this.chatService.setThinkingEffort(this._input.thinkingEffort);

		// Account button → toggle panel
		this._viewDisposables.add(this._header.onAccountClick(() => {
			this._accountPanel.toggle();
		}));

		// Account panel actions
		this._viewDisposables.add(this._accountPanel.onDidRequestManagePlan(() => {
			// Credentials are configured in Settings → Models, not on a website.
			this._accountPanel.close();
			import('./settings/sidexSettingsPanel.js').then(({ SidexSettingsPanel }) => {
				SidexSettingsPanel.getInstance().toggle();
			}).catch(() => { /* panel is optional */ });
		}));

		// Close account panel when clicking outside
		this._viewDisposables.add({
			dispose: () => { /* no-op */ }
		});
		const closeOnOutsideClick = (e: MouseEvent) => {
			if (this._accountPanel.isVisible() &&
				!this._accountPanel.element.contains(e.target as Node) &&
				!(this._header.element.querySelector('.sc-account-btn-header') as HTMLElement | null)?.contains(e.target as Node)
			) {
				this._accountPanel.close();
			}
		};
		document.addEventListener('click', closeOnOutsideClick);
		this._viewDisposables.add({ dispose: () => document.removeEventListener('click', closeOnOutsideClick) });

		this._viewDisposables.add(this._header.onNewChat(() => {
			this._renderedMessageCount = 0;
			this.chatService.clearMessages();
		}));

		this._viewDisposables.add(this._header.onHistory(() => this._fetchSessions()));

		this._viewDisposables.add(this._header.onSearch(query => {
			if (query.length > 1) {
				this.chatService.searchSessions(query).then(sessions => {
					this._header.setSessions(sessions.map(s => ({
						id: s.id,
						title: s.title,
						updated_at: s.date,
						pinned: s.pinned,
					})));
				});
			} else {
				this._fetchSessions();
			}
		}));

		this._viewDisposables.add(this._header.onSelectSession(sessionId => {
			this._renderedMessageCount = 0;
			this.chatService.loadSession(sessionId);
		}));

		this._viewDisposables.add(this._header.onSessionAction(async ({ sessionId, action }) => {
			const sessions = await this.chatService.getSavedSessionsAsync();
			const session = sessions.find(s => s.id === sessionId);
			if (!session) { return; }

			switch (action) {
				case 'pin':
					await this.chatService.pinSession(sessionId, !session.pinned);
					this._fetchSessions();
					break;

				case 'archive':
					await this.chatService.archiveSession(sessionId, true);
					this._fetchSessions();
					break;

				case 'delete':
					if (confirm("Are you sure you want to delete this chat session?")) {
						await this.chatService.deleteSession(sessionId);
						if (this.chatService.sessionId === sessionId) {
							this._renderedMessageCount = 0;
							this.chatService.clearMessages();
						}
						this._fetchSessions();
					}
					break;

				case 'rename':
					const newTitle = prompt("Rename Chat", session.title);
					if (newTitle && newTitle.trim() !== '') {
						await this.chatService.renameSession(sessionId, newTitle.trim());
						this._fetchSessions();
					}
					break;
			}
		}));

		this._viewDisposables.add(this._header.onMenuAction(action => {
			if (action === 'export') {
				this._exportChat();
			} else if (action === 'clear_all') {
				this._renderedMessageCount = 0;
				this.chatService.clearMessages();
			} else if (action === 'open_browser') {
				// Open VS Code's native simple browser tab with a blank/default page
				this.commandService.executeCommand('simpleBrowser.show', 'https://google.com');
			} else if (action === 'configure_rules') {
				const folders = this.contextService.getWorkspace().folders;
				if (folders.length > 0) {
					const rulesUri = URI.joinPath(folders[0].uri, '.sidexrules');
					this.editorService.openEditor({ resource: rulesUri, options: { pinned: true } });
				}
			} else if (action === 'configure_skills' || action === 'edit_memories' || action === 'sidex.profile.settings' || action === 'usage') {
				import('./settings/sidexSettingsPanel.js').then(({ SidexSettingsPanel }) => {
					SidexSettingsPanel.getInstance().toggle();
				}).catch(() => {});
			} else if (action === 'download_diagnostics') {
				const diagnostics = {
					version: '0.1.3',
					platform: navigator.userAgent,
					timestamp: new Date().toISOString(),
					workspace: this.contextService.getWorkspace().folders[0]?.uri.fsPath || 'None',
					active_model: this.chatService.serverModel,
					local_index_active: this.chatService.maxMode,
				};
				const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = `sidex-diagnostics-${Date.now()}.json`;
				a.click();
				URL.revokeObjectURL(url);
			} else if (action.startsWith('vscode.open::')) {
				const url = action.split('::')[1];
				if (url) {
					this.commandService.executeCommand('vscode.open', URI.parse(url));
				}
			}
		}));

		this._viewDisposables.add(this.chatService.onDidChangeMessages(msgs => this._scheduleRender(msgs)));
		this._viewDisposables.add(this.chatService.onDidChangeStreaming(s => {
			this._input.setStreaming(s);
			if (s) {
				this._messagesEl.style.scrollBehavior = 'auto';
			} else {
				this._messagesEl.style.scrollBehavior = '';
			}
		}));

		this._viewDisposables.add(this.chatService.onDidChangeConnectionState(() => {
			if (this.chatService.connectionState === 'connected') {
				if (this.chatService.serverModel) {
					this._input.setModel(this.chatService.serverModel);
				}
				this._fetchSessions();
			}
		}));

		this._viewDisposables.add(this.chatService.onDidChangeModels(models => {
			this._input.setAvailableModels(models);
			// Show the current model and mark it active in the dropdown
			const currentModel = this.chatService.serverModel;
			if (currentModel) {
				this._input.setModel(currentModel);
			}
		}));

		this._viewDisposables.add(this._input.onModelChange(modelId => {
			this.chatService.setSelectedModel(modelId);
		}));

		// Set model immediately from saved/default (before connection)
		if (this.chatService.serverModel) {
			this._input.setModel(this.chatService.serverModel);
		}

		this._viewDisposables.add(this.chatService.onDidReceiveChunk(chunk => {
			if (chunk.type === 'brief' && chunk.content) {
				const text = chunk.content.startsWith('BRIEF:') ? chunk.content.slice(6) : chunk.content;
				this._header.showBrief(text);
			}
			if (chunk.type === 'mode_change' && chunk.mode) {
				this._input.setMode(chunk.mode as 'agent' | 'plan' | 'ask');
			}
			if (chunk.type === 'thinking' && chunk.content) {
				const comp = this._currentAssistantComp;
				if (comp?.thinkingBlock) {
					comp.thinkingBlock.appendContent(chunk.content);
				}
			}
			if (chunk.type === 'thinking_done') {
				const comp = this._currentAssistantComp;
				if (comp?.thinkingBlock) {
					comp.thinkingBlock.stopStreaming();
				}
			}
			if (chunk.type === 'permission_request' && chunk.tool_call_id && chunk.tool_name) {
				this._showPermissionDialog({
					toolCallId: chunk.tool_call_id,
					toolName: chunk.tool_name,
					args: chunk.args,
				});
			}
			if (chunk.type === 'notice' && chunk.content) {
				this._showNotice(chunk.content);
			}
			if (chunk.type === 'error' && chunk.content) {
				this._showErrorBanner(chunk.content);
			}
			if (chunk.type === 'subagent_spawned' && chunk.subagent_id) {
				this._showSubagentCard({
					id: chunk.subagent_id,
					description: chunk.subagent_description || 'Subagent',
					model: chunk.subagent_model || '',
					status: 'running',
					prompt: chunk.subagent_prompt || '',
					toolCalls: [],
					output: '',
					startedAt: Date.now(),
				});
			}
			if ((chunk.type === 'subagent_complete' || chunk.type === 'subagent_update') && chunk.subagent_id) {
				const card = this._subagentCards.get(chunk.subagent_id);
				if (card) {
					card.update({
						status: chunk.subagent_status,
						output: chunk.subagent_output,
						toolCalls: chunk.subagent_tools?.map(t => ({ ...t, output: undefined })),
					});
				}
			}
			if (chunk.type === 'ask_question' && chunk.question_options) {
				this._showQuestionDialog({
					toolCallId: chunk.tool_call_id || chunk.question_id || '',
					title: chunk.question_title,
					prompt: chunk.question_prompt || '',
					options: chunk.question_options,
					allowMultiple: chunk.question_allow_multiple || false,
				});
			}
		}));
	}

	private _currentAssistantComp: AssistantMessage | null = null;
	private _lastRenderTime: number = 0;

	private _scheduleRender(messages: readonly IChatMessage[]): void {
		this._pendingMessages = messages;
		if (this._renderPending) { return; }
		this._renderPending = true;

		// During streaming, throttle re-renders to max ~15fps (66ms)
		// to avoid O(n²) markdown re-rendering on every token
		const now = performance.now();
		const elapsed = now - this._lastRenderTime;
		const delay = elapsed < 66 ? 66 - elapsed : 0;

		if (delay === 0) {
			requestAnimationFrame(() => {
				this._renderPending = false;
				this._lastRenderTime = performance.now();
				this._renderMessages(this._pendingMessages);
			});
		} else {
			setTimeout(() => {
				this._renderPending = false;
				this._lastRenderTime = performance.now();
				this._renderMessages(this._pendingMessages);
			}, delay);
		}
	}

	private _currentSessionId: string | null = null;

	private _renderMessages(messages: readonly IChatMessage[]): void {
		if (!this._messagesEl) { return; }

		// Check if we switched to a completely different chat session
		if (this.chatService.sessionId !== this._currentSessionId) {
			this._currentSessionId = this.chatService.sessionId;
			DOM.clearNode(this._messagesEl);
			this._messagesEl.appendChild(this._welcomeEl);
			this._currentAssistantComp = null;
			this._renderedMessageCount = 0;
			this._lastDiffRebuildEditCount = 0;
		}

		const hasMessages = messages.length > 0;

		// Remove the animated SVG from DOM entirely when hidden to stop SMIL timers
		if (hasMessages && this._welcomeEl.parentNode) {
			this._welcomeEl.remove();
		}

		if (!hasMessages) {
			DOM.clearNode(this._messagesEl);
			this._messagesEl.appendChild(this._welcomeEl);
			this._welcomeEl.style.display = 'flex';
			this._currentAssistantComp = null;
			this._renderedMessageCount = 0;
			return;
		}

		// When messages are removed (revert), remove excess DOM nodes from the end
		// instead of clearing everything (which causes a visible flicker).
		if (messages.length < this._renderedMessageCount) {
			const children = this._messagesEl.children;
			// Remove children from the end until we match the new message count
			while (children.length > messages.length) {
				const last = children[children.length - 1];
				if (last === this._welcomeEl) { break; }
				last.remove();
			}
			this._currentAssistantComp = null;
			this._renderedMessageCount = messages.length;

			if (messages.length === 0) {
				DOM.clearNode(this._messagesEl);
				this._messagesEl.appendChild(this._welcomeEl);
				this._welcomeEl.style.display = 'flex';
				this._renderedMessageCount = 0;
				return;
			}
			return;
		}

		// When tool_result updates a tool status to 'done', check if we need to rebuild
		// to show the diff (since tool calls may be in ANY previous message)
		if (messages.length === this._renderedMessageCount) {
			const totalDoneEdits = messages.reduce((count, msg) => {
				if (!msg.toolCalls) { return count; }
				return count + msg.toolCalls.filter(tc =>
					(tc.name === 'edit_file' || tc.name === 'write_file' || tc.name === 'multi_edit' ||
					 tc.name === 'create_file' || tc.name === 'str_replace_editor') &&
					tc.status === 'done' && tc.input
				).length;
			}, 0);

			const existingDiffs = this._messagesEl.querySelectorAll('.sc-tool-call-diff, .ui-edit-tool-call').length;
			if (totalDoneEdits > 0 && existingDiffs < totalDoneEdits && totalDoneEdits > this._lastDiffRebuildEditCount) {
				this._lastDiffRebuildEditCount = totalDoneEdits;
				DOM.clearNode(this._messagesEl);
				this._messagesEl.appendChild(this._welcomeEl);
				this._currentAssistantComp = null;
				this._renderedMessageCount = 0;
			}
		}

		// Append only new messages that haven't been rendered yet
		for (let i = this._renderedMessageCount; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role === 'user') {
				const msgIndex = i;
				const comp = new UserMessage(msg, () => {
					this.chatService.revertToMessage(msgIndex);
				});
				comp.appendTo(this._messagesEl);
				this._viewDisposables.add(comp);
			} else if (msg.role === 'assistant') {
				const duration = this._turnStartTime > 0 ? Date.now() - this._turnStartTime : 0;
				const isThinking = this.chatService.isThinking && i === messages.length - 1;
				const comp = new AssistantMessage(msg, duration, (filePath) => {
					this._openFile(filePath);
				}, isThinking, messages, this.languageService, this.modelService);
				comp.appendTo(this._messagesEl);
				this._viewDisposables.add(comp);
				this._viewDisposables.add(comp.onCopy(text => {
					navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
				}));
				this._currentAssistantComp = comp;
			}
		}
		this._renderedMessageCount = messages.length;

		// Update the last assistant message body in-place (streaming content)
		const lastMsg = messages[messages.length - 1];
		if (lastMsg.role === 'assistant' && this._currentAssistantComp) {
			this._updateAssistantBody(this._currentAssistantComp, lastMsg);
		}

		// Render reverted messages dimmed + redo link
		this._renderRevertedMessages();

		// Streaming cursor
		this._updateStreamingCursor();

		this._scrollToBottom();
	}

	private _updateAssistantBody(comp: AssistantMessage, msg: IChatMessage): void {
		const bodyEl = comp.element.querySelector('.markdown-root') as HTMLElement | null;
		if (bodyEl) {
			const rendered = renderMarkdown(msg.content);
			if (bodyEl.innerHTML !== rendered) {
				bodyEl.innerHTML = rendered;
			}
		} else if (msg.content) {
			const newBody = document.createElement('div');
			newBody.className = 'sc-assistant-body';
			newBody.innerHTML = renderMarkdown(msg.content);
			comp.element.appendChild(newBody);
		}
	}

	private _updateStreamingCursor(): void {
		const existing = this._messagesEl.querySelector('.sc-streaming-cursor');
		if (this.chatService.isStreaming) {
			if (!existing) {
				const cursor = document.createElement('span');
				cursor.className = 'sc-streaming-cursor';
				const lastBody = this._messagesEl.querySelector('.composer-rendered-message:last-child .markdown-root');
				if (lastBody) { lastBody.appendChild(cursor); }
			}
		} else if (existing) {
			existing.remove();
		}
	}

	private _renderRevertedMessages(): void {
		// Clean up previous reverted container
		if (this._revertedContainer) {
			this._revertedContainer.remove();
			this._revertedContainer = null;
		}
		if (this._redoLinkEl) {
			this._redoLinkEl.remove();
			this._redoLinkEl = null;
		}

		const reverted = this.chatService.revertedMessages;
		if (reverted.length === 0) { return; }

		// Redo checkpoint link (above the dimmed messages)
		const redoLink = document.createElement('div');
		redoLink.className = 'sc-redo-checkpoint';
		redoLink.textContent = 'Redo checkpoint';
		redoLink.addEventListener('click', () => {
			this.chatService.redoCheckpoint();
		});
		this._messagesEl.appendChild(redoLink);
		this._redoLinkEl = redoLink;

		// Container for dimmed reverted messages
		const container = document.createElement('div');
		container.className = 'sc-reverted-messages';

		for (const msg of reverted) {
			const el = document.createElement('div');
			if (msg.role === 'user') {
				el.className = 'composer-rendered-message sc-reverted-msg';
				el.style.cssText = 'display: block; outline: none; padding-top: 10px; margin-bottom: 6px; position: relative; width: 100%; opacity: 0.5;';
				const container = document.createElement('div');
				container.style.cssText = 'display: flex; align-items: flex-start; gap: 8px; width: 100%; outline: none; border-radius: 12px;';
				const wrapper = document.createElement('div');
				wrapper.style.cssText = 'display: flex; flex-direction: column; align-items: flex-end; width: 100%;';
				const messageBox = document.createElement('div');
				messageBox.style.cssText = 'background-color: color-mix(in srgb, var(--vscode-input-background) 90%, #181818); padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.5; color: var(--vscode-foreground); word-wrap: break-word;';
				messageBox.textContent = msg.content;
				wrapper.appendChild(messageBox);
				container.appendChild(wrapper);
				el.appendChild(container);
			} else if (msg.role === 'assistant') {
				el.className = 'composer-rendered-message sc-reverted-msg';
				el.style.cssText = 'display: block; outline: none; padding-top: 0px; padding-bottom: 0px; background-color: var(--composer-pane-background); opacity: 0.5; z-index: 99; margin-bottom: 12px;';
				const bodyWrapper = document.createElement('div');
				bodyWrapper.className = 'markdown-root';
				bodyWrapper.style.cssText = 'font-size: 13px; line-height: 1.5; color: var(--vscode-foreground);';
				const body = document.createElement('div');
				body.style.cssText = 'display: flex; flex-direction: column; gap: 8px; white-space: normal; overflow-wrap: break-word;';
				body.innerHTML = renderMarkdown(msg.content);
				bodyWrapper.appendChild(body);
				el.appendChild(bodyWrapper);
			}
			container.appendChild(el);
		}

		this._messagesEl.appendChild(container);
		this._revertedContainer = container;
	}

	private _scrollToBottom(): void {
		if (this._messagesEl && !this._userHasScrolledUp && this._autoScrollValue) {
			this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override focus(): void {
		this._input?.focus();
	}

	private _fetchSessions(): void {
		this.chatService.getSavedSessionsAsync().then(sessions => {
			this._header.setSessions(sessions.map(s => ({
				id: s.id,
				title: s.title,
				updated_at: s.date,
				pinned: s.pinned,
			})));
		});
	}

	private _exportChat(): void {
		const msgs = this.chatService.messages;
		const text = msgs.map(m => `[${m.role}]\n${m.content}\n`).join('\n---\n\n');
		navigator.clipboard.writeText(text).catch(() => { /* */ });
	}

	private _getOpenerService() {
		return this.openerService ?? null;
	}

	private _openFile(filePath: string): void {
		const uri = URI.file(filePath);
		this.editorService.openEditor({ resource: uri }).then(undefined, () => { /* ignore */ });
	}

	private _showPermissionDialog(data: PermissionRequestData): void {
		if (!this._messagesEl) { return; }
		const dialog = new PermissionRequestDialog(data);
		dialog.appendTo(this._messagesEl);
		this._viewDisposables.add(dialog);
		this._viewDisposables.add(dialog.onRespond(result => {
			this.chatService.respondToPermission(result.toolCallId, result.approved);
		}));
		this._scrollToBottom();
	}

	private _showErrorBanner(text: string): void {
		const existing = this._input.element.parentElement?.querySelector('.sc-error-banner');
		if (existing) { existing.remove(); }

		const requestId = crypto.randomUUID?.() || Math.random().toString(36).slice(2);

		const banner = document.createElement('div');
		banner.className = 'sc-error-banner';

		// Row 1: icon + title ... X dismiss
		const row1 = document.createElement('div');
		row1.className = 'sc-error-banner-row1';
		const icon = document.createElement('span');
		icon.className = 'codicon codicon-warning';
		row1.appendChild(icon);
		const title = document.createElement('span');
		title.className = 'sc-error-banner-title';
		title.textContent = text.includes('usage cap') || text.includes('Anthropic returned 429')
			? 'Claude usage limit'
			: text.includes('Anthropic blocked') || text.includes('Anthropic refused')
				? 'Anthropic blocked this login'
				: 'Unable to reach model';
		row1.appendChild(title);
		banner.appendChild(row1);

		// X button (absolute positioned top-right)
		const dismiss = document.createElement('span');
		dismiss.className = 'sc-error-banner-dismiss codicon codicon-chrome-close';
		dismiss.addEventListener('click', () => banner.remove());
		banner.appendChild(dismiss);

		// Row 2: description
		const desc = document.createElement('div');
		desc.className = 'sc-error-banner-desc';
		desc.textContent = text;
		banner.appendChild(desc);

		// Row 3: request ID + Try again
		const row3 = document.createElement('div');
		row3.className = 'sc-error-banner-row3';
		const idEl = document.createElement('span');
		idEl.className = 'sc-error-banner-id';
		idEl.textContent = `Request (${requestId.slice(0, 8)})`;
		row3.appendChild(idEl);

		const retryBtn = document.createElement('button');
		retryBtn.className = 'sc-error-banner-retry';
		retryBtn.textContent = 'Try again';
		retryBtn.addEventListener('click', () => {
			banner.remove();
			// Retry: just call sendMessage with the last user text.
			// The service will handle deduplication — it checks if the last
			// message is already from the user with the same content.
			const msgs = this.chatService.messages;
			const lastUser = [...msgs].reverse().find(m => m.role === 'user');
			if (lastUser) {
				// Remove any trailing empty/failed assistant messages
				const lastIdx = msgs.length - 1;
				if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant' && !msgs[lastIdx].content?.trim()) {
					this.chatService.revertToMessage(lastIdx);
				}
				this.chatService.sendMessage(lastUser.content);
			} else {
				this._input.focus();
			}
		});
		row3.appendChild(retryBtn);
		banner.appendChild(row3);

		this._input.element.parentElement?.insertBefore(banner, this._input.element);
	}

	private _showNotice(text: string): void {
		if (!this._messagesEl) { return; }
		if (this._noticeTimer) { clearTimeout(this._noticeTimer); }

		const existing = this._messagesEl.querySelector('.sc-notice-toast');
		if (existing) { existing.remove(); }

		const toast = document.createElement('div');
		toast.className = 'sc-notice-toast';
		const iconEl = document.createElement('span');
		iconEl.className = 'sc-notice-icon codicon codicon-info';
		toast.appendChild(iconEl);
		const textEl = document.createElement('span');
		textEl.textContent = text;
		toast.appendChild(textEl);
		this._messagesEl.appendChild(toast);
		this._scrollToBottom();

		this._noticeTimer = setTimeout(() => {
			toast.classList.add('sc-notice-exit');
			setTimeout(() => toast.remove(), 300);
		}, 4000);
	}

	// ─── Orchestration ─────────────────────────────────────────────────────────

	private _showSubagentCard(info: SubagentInfo): void {
		if (!this._messagesEl) { return; }
		const card = new SubagentCard(info);
		card.appendTo(this._messagesEl);
		this._viewDisposables.add(card);
		this._subagentCards.set(info.id, card);
		this._scrollToBottom();
	}

	private _showQuestionDialog(data: { toolCallId: string; title?: string; prompt: string; options: Array<{ id: string; label: string }>; allowMultiple: boolean }): void {
		if (!this._messagesEl) { return; }
		const dialog = new QuestionDialog(data);
		dialog.appendTo(this._messagesEl);
		this._viewDisposables.add(dialog);
		this._viewDisposables.add(dialog.onRespond(result => {
			this.chatService.respondToQuestion(result.toolCallId, result.selectedIds);
		}));
		this._scrollToBottom();
	}

	private _startOrchestration(goal: string): void {
		// Clean up previous orchestration
		this._orchStream?.cancel();
		this._orchStream?.dispose();
		this._orchView?.dispose();
		this._orchestrator?.dispose();

		const wsUrl = serverWsUrl(this.configurationService.getValue<string>('sidex.chat.serverUrl'));

		this._orchestrator = new SidexOrchestrator();
		this._viewDisposables.add(this._orchestrator);

		// Create the orchestration view component
		this._orchView = new OrchestrationView();
		this._orchView.appendTo(this._messagesEl);
		this._viewDisposables.add(this._orchView);
		this._viewDisposables.add(this._orchView.onCancel(() => {
			this._orchestrator?.cancel('User cancelled from UI');
		}));

		// Stream events into the UI with RAF throttling
		this._orchStream = new StreamConsumer(this._orchestrator.onEvent, {
			throttleToFrame: true,
		});
		this._viewDisposables.add(this._orchStream);

		// Pipe events to the view
		this._viewDisposables.add(this._orchestrator.onEvent(event => {
			this._orchView?.handleEvent(event);
			if (!this._userHasScrolledUp) {
				this._scrollToBottom();
			}
		}));

		// Kick off
		const workspace = this.chatService.messages.length > 0
			? '.'
			: '.';
		this._orchestrator.orchestrate(goal, wsUrl, workspace).catch(() => {
			// Orchestration failed
		});
	}
}
