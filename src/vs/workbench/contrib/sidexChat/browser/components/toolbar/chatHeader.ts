import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IAccountService } from '../../account/accountService.js';

function icon(codicon: ThemeIcon): HTMLSpanElement {
	const el = document.createElement('span');
	el.classList.add(...ThemeIcon.asClassNameArray(codicon));
	return el;
}

export interface ISessionItem {
	id: string;
	title: string;
	updated_at?: string;
	pinned?: boolean;
}

export interface ISessionAction {
	sessionId: string;
	action: 'pin' | 'archive' | 'delete' | 'rename';
}

export class ChatHeader extends Component {
	private readonly _onNewChat = this._register(new Emitter<void>());
	readonly onNewChat: Event<void> = this._onNewChat.event;

	private readonly _onHistory = this._register(new Emitter<void>());
	readonly onHistory: Event<void> = this._onHistory.event;

	private readonly _onSelectSession = this._register(new Emitter<string>());
	readonly onSelectSession: Event<string> = this._onSelectSession.event;

	private readonly _onMenuAction = this._register(new Emitter<string>());
	readonly onMenuAction: Event<string> = this._onMenuAction.event;

	private readonly _onSearch = this._register(new Emitter<string>());
	readonly onSearch: Event<string> = this._onSearch.event;

	private readonly _onSessionAction = this._register(new Emitter<ISessionAction>());
	readonly onSessionAction: Event<ISessionAction> = this._onSessionAction.event;

	// There is no sign-in-gated account affordance in the header anymore, so
	// nothing here fires this. It stays because sidexChatView.ts still
	// subscribes to it to toggle the account panel.
	private readonly _onAccountClick = this._register(new Emitter<void>());
	readonly onAccountClick: Event<void> = this._onAccountClick.event;

	private _historyPanel: HTMLElement;
	private _historyList: HTMLElement;
	private _menuPanel: HTMLElement;
	private _itemContextMenu: HTMLElement;
	private _briefEl: HTMLElement;
	private _briefTimer: ReturnType<typeof setTimeout> | undefined;
	private _searchInput: HTMLInputElement;
	private _searchBar: HTMLElement;
	private _menuBtn: HTMLElement;

	// Unused now that the header has no account button, but kept so the
	// constructor signature still matches the `new ChatHeader(this.accountService)`
	// call in sidexChatView.ts.
	constructor(private readonly _accountService?: IAccountService) {
		super('div', 'sc-header');

		// + New Chat (left side)
		const newBtn = this.append('button', 'sc-header-btn');
		newBtn.title = 'New Chat';
		newBtn.appendChild(icon(Codicon.add));
		this.on(newBtn, 'click', () => this._onNewChat.fire());

		// Persistent search bar (center)
		this._searchBar = this.append('div', 'sc-header-search');
		this._searchInput = DOM.append(this._searchBar, $('input.sc-header-search-input')) as HTMLInputElement;
		this._searchInput.type = 'text';
		this._searchInput.placeholder = 'Search chats...';

		// History dropdown panel (child of search bar for positioning)
		this._historyPanel = DOM.append(this._searchBar, $('div.sc-history-panel'));
		this._historyList = DOM.append(this._historyPanel, $('div.sc-history-list'));

		// Item context menu (shared, repositioned per item)
		this._itemContextMenu = DOM.append(this._historyPanel, $('div.sc-item-context-menu'));
		const contextActions: Array<{ id: string; label: string; codicon: ThemeIcon }> = [
			{ id: 'pin', label: 'Pin', codicon: Codicon.pin },
			{ id: 'archive', label: 'Archive', codicon: Codicon.archive },
			{ id: 'separator', label: '', codicon: Codicon.dash },
			{ id: 'rename', label: 'Rename', codicon: Codicon.edit },
			{ id: 'delete', label: 'Delete', codicon: Codicon.trashcan },
		];
		for (const action of contextActions) {
			if (action.id === 'separator') {
				DOM.append(this._itemContextMenu, $('div.sc-context-separator'));
				continue;
			}
			const row = DOM.append(this._itemContextMenu, $('div.sc-context-item'));
			row.appendChild(icon(action.codicon));
			const label = DOM.append(row, $('span'));
			label.textContent = action.label;
			row.dataset.action = action.id;
		}
		this.on(this._itemContextMenu, 'click', (e) => {
			const target = (e.target as HTMLElement).closest('.sc-context-item') as HTMLElement | null;
			if (!target) { return; }
			const sessionId = this._itemContextMenu.dataset.sessionId || '';
			const action = target.dataset.action as ISessionAction['action'];
			if (sessionId && action) {
				this._onSessionAction.fire({ sessionId, action });
			}
			this._itemContextMenu.classList.remove('visible');
		});

		// Show history on focus
		this.on(this._searchInput, 'focus', () => {
			this._closeMenu();
			if (!this._historyPanel.classList.contains('visible')) {
				this._openHistory();
			}
		});

		// Filter/search on input
		this.on(this._searchInput, 'input', () => {
			const query = this._searchInput.value;
			this._onSearch.fire(query);
			if (!this._historyPanel.classList.contains('visible')) {
				this._openHistory();
			}
			this._filterHistory(query);
		});

		// Close on Escape
		this.on(this._searchInput, 'keydown', (e) => {
			if ((e as KeyboardEvent).key === 'Escape') {
				this._searchInput.value = '';
				this._searchInput.blur();
				this._closeHistory();
			}
		});

		// ... Menu (right side)
		this._menuBtn = this.append('button', 'sc-header-btn');
		this._menuBtn.title = 'More';
		this._menuBtn.appendChild(icon(Codicon.ellipsis));
		this.on(this._menuBtn, 'click', () => this._toggleMenu());

		// Menu dropdown panel (child of header for left-aligned snapping)
		this._menuPanel = DOM.append(this.element, $('div.sc-menu-panel'));
		const menuItems: Array<{ id: string; label: string; codicon: ThemeIcon; disabled?: boolean }> = [
			{ id: 'open_browser', label: 'Open Browser', codicon: Codicon.browser },
			{ id: 'separator', label: '', codicon: Codicon.dash },
			{ id: 'usage', label: 'Usage', codicon: Codicon.dashboard },
			{ id: 'separator', label: '', codicon: Codicon.dash },
			{ id: 'configure_rules', label: 'Configure Rules', codicon: Codicon.notebook },
			{ id: 'configure_skills', label: 'Configure Skills', codicon: Codicon.book },
			{ id: 'edit_memories', label: 'Edit Memories', codicon: Codicon.lightbulb },
		];
		for (const item of menuItems) {
			if (item.id === 'separator') {
				DOM.append(this._menuPanel, $('div.sc-menu-separator'));
				continue;
			}
			const row = DOM.append(this._menuPanel, $('div.sc-menu-item'));
			if (item.disabled) {
				row.classList.add('disabled');
			}
			row.appendChild(icon(item.codicon));
			const label = DOM.append(row, $('span'));
			label.textContent = item.label;
			
			if (item.disabled) {
				// Prevent clicking disabled coming-soon items
				this.on(row, 'click', (e) => e.stopPropagation());
				continue;
			}

			this.on(row, 'click', () => {
				this._closeMenu();
				this._onMenuAction.fire(item.id);
			});
		}

		// Bottom MCP status bar (Cursor/Windsurf style)
		const mcpBar = DOM.append(this._menuPanel, $('div.sc-menu-mcp-bar'));
		const mcpLeft = DOM.append(mcpBar, $('div.sc-menu-mcp-left'));
		mcpLeft.textContent = '0 MCPs';

		const mcpRight = DOM.append(mcpBar, $('div.sc-menu-mcp-right'));
		const gearBtn = DOM.append(mcpRight, $('button.sc-menu-mcp-btn'));
		gearBtn.title = 'Configure MCP Servers';
		gearBtn.appendChild(icon(Codicon.settingsGear));
		this.on(gearBtn, 'click', (e) => {
			e.stopPropagation();
			this._closeMenu();
			this._onMenuAction.fire('sidex.profile.settings');
		});

		// Query real MCP servers count in the background on startup
		try {
			const g = globalThis as any;
			const invoke = g.__TAURI_INVOKE__ ?? g.__TAI_INTERNALS__?.invoke ?? g.__TAURI_INTERNALS__?.invoke;
			if (invoke) {
				invoke('mcp_list_servers').then((servers: any) => {
					const count = Array.isArray(servers) ? servers.length : typeof servers === 'object' && servers ? Object.keys(servers).length : 0;
					mcpLeft.textContent = `${count} MCPs`;
				}).catch(() => {});
			}
		} catch { /* ignore */ }

		// Close panels on outside click
		this.on(document.body, 'click', (e) => {
			if (!this.element.contains(e.target as Node)) {
				this._closeHistory();
				this._closeMenu();
			}
			if (!this._itemContextMenu.contains(e.target as Node)) {
				this._itemContextMenu.classList.remove('visible');
			}
		});

		// Brief banner
		this._briefEl = this.append('div', 'sc-brief-banner');
	}

	showBrief(text: string): void {
		if (this._briefTimer) { clearTimeout(this._briefTimer); }
		this._briefEl.textContent = text;
		this._briefEl.classList.add('visible');
		this._briefTimer = setTimeout(() => {
			this._briefEl.classList.remove('visible');
		}, 5000);
	}

	setSessions(sessions: ISessionItem[]): void {
		DOM.clearNode(this._historyList);
		if (sessions.length === 0) {
			const empty = DOM.append(this._historyList, $('div.sc-history-empty'));
			empty.textContent = 'No past chats';
			return;
		}
		for (const s of sessions) {
			const row = DOM.append(this._historyList, $('div.sc-history-item'));
			row.dataset.id = s.id;
			row.dataset.title = (s.title || '').toLowerCase();
			const titleEl = DOM.append(row, $('span.sc-history-title'));
			titleEl.textContent = s.title || 'Untitled';
			if (s.updated_at) {
				const dateEl = DOM.append(row, $('span.sc-history-date'));
				dateEl.textContent = new Date(s.updated_at).toLocaleDateString();
			}

			const actions = DOM.append(row, $('div.sc-history-actions'));
			const moreBtn = DOM.append(actions, $('button.sc-history-action-btn'));
			moreBtn.title = 'More';
			moreBtn.appendChild(icon(Codicon.ellipsis));
			const pinBtn = DOM.append(actions, $('button.sc-history-action-btn'));
			pinBtn.title = 'Pin';
			pinBtn.appendChild(icon(Codicon.pin));
			if (s.pinned) { pinBtn.classList.add('active'); }
			const archiveBtn = DOM.append(actions, $('button.sc-history-action-btn'));
			archiveBtn.title = 'Archive';
			archiveBtn.appendChild(icon(Codicon.archive));

			this.on(pinBtn, 'click', (e) => {
				e.stopPropagation();
				this._onSessionAction.fire({ sessionId: s.id, action: 'pin' });
			});
			this.on(archiveBtn, 'click', (e) => {
				e.stopPropagation();
				this._onSessionAction.fire({ sessionId: s.id, action: 'archive' });
			});
			this.on(moreBtn, 'click', (e) => {
				e.stopPropagation();
				this._showItemContextMenu(s.id, moreBtn);
			});

			this.on(row, 'click', () => {
				this._closeHistory();
				this._onSelectSession.fire(s.id);
			});
		}
	}

	private _toggleHistory(): void {
		this._closeMenu();
		const wasHidden = !this._historyPanel.classList.contains('visible');
		if (wasHidden) {
			this._openHistory();
		} else {
			this._closeHistory();
		}
	}

	private _openHistory(): void {
		this._historyPanel.classList.add('visible');
		this._searchBar.classList.add('panel-open');
		this._onHistory.fire();
	}

	private _closeHistory(): void {
		this._historyPanel.classList.remove('visible');
		this._searchBar.classList.remove('panel-open');
	}

	private _toggleMenu(): void {
		this._closeHistory();
		const wasHidden = !this._menuPanel.classList.contains('visible');
		if (wasHidden) {
			this._openMenu();
		} else {
			this._closeMenu();
		}
	}

	private _openMenu(): void {
		this._menuPanel.classList.add('visible');
		this._menuBtn.classList.add('panel-open');
	}

	private _closeMenu(): void {
		this._menuPanel.classList.remove('visible');
		this._menuBtn.classList.remove('panel-open');
	}

	private _showItemContextMenu(sessionId: string, anchor: HTMLElement): void {
		this._itemContextMenu.dataset.sessionId = sessionId;
		this._itemContextMenu.classList.add('visible');
		const rect = anchor.getBoundingClientRect();
		const panelRect = this._historyPanel.getBoundingClientRect();
		this._itemContextMenu.style.top = `${rect.bottom - panelRect.top}px`;
		this._itemContextMenu.style.right = `${panelRect.right - rect.right}px`;
	}

	private _filterHistory(query: string): void {
		const q = query.toLowerCase();
		const items = this._historyList.querySelectorAll('.sc-history-item');
		for (const item of items) {
			const el = item as HTMLElement;
			const title = el.dataset.title || '';
			el.style.display = !q || title.includes(q) ? '' : 'none';
		}
	}

}
