/*---------------------------------------------------------------------------------------------
 *  SideX Settings Panel — modal dialog with sidebar navigation.
 *  Uses the real VS Code modal-editor classes (.monaco-modal-editor-block,
 *  .modal-editor-part, .modal-editor-header, .modal-editor-sidebar, etc.)
 *  so it inherits all workbench CSS directly with no custom overrides.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureSettingsStyles } from './sidexSettingsStyles.js';
import { GeneralSection } from './sections/generalSection.js';
import { PlanUsageSection } from './sections/planUsageSection.js';
import { ModelsSection } from './sections/modelsSection.js';
import { RulesSection } from './sections/rulesSection.js';
import { ToolsSection } from './sections/toolsSection.js';
import { IndexingSection } from './sections/indexingSection.js';
import { ConfigurationSection } from './sections/configurationSection.js';

export interface NavItem {
	type?: 'separator';
	id?: string;
	label?: string;
	icon?: string;
	external?: boolean;
	disabled?: boolean;
}

export interface SettingsSection {
	render(container: HTMLElement): void;
	dispose?(): void;
}

const NAV_ITEMS: NavItem[] = [
	{ id: 'general', label: 'General', icon: 'codicon-account' },
	{ id: 'plan-usage', label: 'Usage', icon: 'codicon-graph' },
	{ type: 'separator' },
	{ id: 'models', label: 'Models', icon: 'codicon-circuit-board' },
	{ id: 'rules', label: 'Customizations', icon: 'codicon-file-text' },
	{ id: 'tools', label: 'Tools & MCPs', icon: 'codicon-tools' },
	{ id: 'configuration', label: 'Configuration', icon: 'codicon-gear' },
	{ type: 'separator' },
	{ id: 'preferences', label: 'Preferences', icon: 'codicon-settings' },
	{ id: 'notifications', label: 'Notifications', icon: 'codicon-bell' },
	{ type: 'separator' },
	{ id: 'indexing', label: 'Indexing & Stats', icon: 'codicon-database' },
	{ id: 'privacy', label: 'Privacy', icon: 'codicon-lock' },
];

let _instance: SidexSettingsPanel | null = null;

export class SidexSettingsPanel extends Disposable {
	private _overlay!: HTMLElement;
	private _content!: HTMLElement;
	private _navContainer!: HTMLElement;
	private _accountContainer!: HTMLElement;
	private _resizable!: HTMLElement;
	private _layoutResizable!: () => void;
	private _isMaximized: boolean = false;
	private _activeSection: string = 'general';
	private _isOpen: boolean = false;
	private _disposables = this._register(new DisposableStore());
	private _sections: SettingsSection[] = [];
	private _navElements: Map<string, HTMLElement> = new Map();
	private _isScrollingFromClick: boolean = false;
	private _scrollSpyTimeout: ReturnType<typeof setTimeout> | null = null;

	static getInstance(): SidexSettingsPanel {
		if (!_instance) {
			_instance = new SidexSettingsPanel();
		}
		return _instance;
	}

	private constructor() {
		super();
		ensureSettingsStyles();
		this._buildDOM();
		this._bindEvents();
	}

	private _getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
		const g = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
		return g.__TAURI_INTERNALS__?.invoke ?? null;
	}

	private _buildDOM(): void {
		// .monaco-modal-editor-block — the real class, inherits real CSS
		this._overlay = document.createElement('div');
		this._overlay.className = 'monaco-modal-editor-block';
		this._overlay.style.display = 'none';
		this._overlay.style.background = 'rgba(0, 0, 0, 0.3)';

		// .modal-editor-resizable — match real VS Code modal layout calculation:
		// width = min(80vw, 1400px, 100vw), height = min(80% available, 900px)
		// centered: left = (100vw - width) / 2, top = centered but clamped below titlebar
		const resizable = document.createElement('div');
		resizable.className = 'modal-editor-resizable';
		this._overlay.appendChild(resizable);
		this._resizable = resizable;

		const layoutResizable = () => {
			if (this._isMaximized) {
				resizable.style.cssText = `position:absolute;width:100%;height:100%;left:0;top:0;`;
				return;
			}
			const cw = window.innerWidth;
			const ch = window.innerHeight;
			const titleBarOffset = 30;
			const availableHeight = ch - titleBarOffset;
			const width = Math.min(cw * 0.8, 1400, cw);
			const height = Math.min(availableHeight * 0.8, 900, availableHeight);
			const left = (cw - width) / 2;
			const top = Math.max(titleBarOffset, (ch - height) / 2);
			resizable.style.cssText = `position:absolute;width:${width}px;height:${height}px;left:${left}px;top:${top}px;`;
		};
		this._layoutResizable = layoutResizable;
		layoutResizable();
		window.addEventListener('resize', layoutResizable);
		this._disposables.add({ dispose: () => window.removeEventListener('resize', layoutResizable) });

		// .modal-editor-shadow — inherits box-shadow, border-radius
		const shadow = document.createElement('div');
		shadow.className = 'modal-editor-shadow';
		shadow.style.cssText = 'box-shadow:0 8px 32px rgba(0,0,0,0.5);border-radius:8px;overflow:hidden;width:100%;height:100%;';
		resizable.appendChild(shadow);

		// .modal-editor-part.has-sidebar — the grid container
		const part = document.createElement('div');
		part.className = 'part editor modal-editor-part has-sidebar';
		part.style.cssText = 'display:grid;grid-template-rows:auto 1fr;grid-template-columns:auto 1fr;width:100%;height:100%;background-color:var(--vscode-sideBar-background, #141414);border:1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.09));border-radius:8px;overflow:hidden;position:relative;';
		part.setAttribute('role', 'dialog');
		part.setAttribute('aria-modal', 'true');
		part.setAttribute('aria-labelledby', 'sidex-modal-editor-title');
		shadow.appendChild(part);

		// .modal-editor-header — inherits real header styling
		this._buildHeader(part);

		// .modal-editor-sidebar — inherits real sidebar styling
		this._buildSidebar(part);

		// .content — the right pane, scrollable
		const contentWrapper = document.createElement('div');
		contentWrapper.className = 'content';
		contentWrapper.style.cssText = 'grid-column:2;grid-row:2;overflow:hidden;min-width:0;min-height:0;position:relative;background-color:var(--vscode-sideBar-background, #141414);';
		part.appendChild(contentWrapper);

		this._content = document.createElement('div');
		this._content.className = 'sidex-settings-content';
		this._content.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;overflow-y:scroll;overflow-x:hidden;scrollbar-width:none;padding-bottom:50vh;box-sizing:border-box;';
		contentWrapper.appendChild(this._content);

		// Custom scrollbar overlay (mimics VS Code's .invisible.scrollbar.vertical.fade)
		const scrollbar = document.createElement('div');
		scrollbar.setAttribute('role', 'presentation');
		scrollbar.setAttribute('aria-hidden', 'true');
		scrollbar.className = 'invisible scrollbar vertical fade';
		scrollbar.style.cssText = 'position:absolute;width:10px;right:0;top:0;bottom:0;';
		const slider = document.createElement('div');
		slider.className = 'slider';
		slider.style.cssText = 'position:absolute;top:0;left:0;width:10px;contain:strict;border-radius:5px;min-height:20px;';
		scrollbar.appendChild(slider);
		contentWrapper.appendChild(scrollbar);

		let fadeTimeout: ReturnType<typeof setTimeout> | null = null;
		const showScrollbar = () => {
			scrollbar.className = 'visible scrollbar vertical fade';
			if (fadeTimeout) { clearTimeout(fadeTimeout); }
			fadeTimeout = setTimeout(() => {
				scrollbar.className = 'invisible scrollbar vertical fade';
			}, 1000);
		};

		const updateSlider = () => {
			const { scrollTop, scrollHeight, clientHeight } = this._content;
			if (scrollHeight <= clientHeight) {
				slider.style.display = 'none';
				return;
			}
			slider.style.display = '';
			const ratio = clientHeight / scrollHeight;
			const sliderHeight = Math.max(20, ratio * clientHeight);
			const maxTop = clientHeight - sliderHeight;
			const scrollRatio = scrollTop / (scrollHeight - clientHeight);
			slider.style.height = `${sliderHeight}px`;
			slider.style.transform = `translate3d(0px, ${scrollRatio * maxTop}px, 0px)`;
		};

		this._content.addEventListener('scroll', () => {
			updateSlider();
			showScrollbar();

			if (!this._isScrollingFromClick) {
				const scrollSections = this._content.querySelectorAll('.sidex-settings-scroll-section');
				let activeId = this._activeSection;
				let maxTopPassed = -Infinity;

				const contentRect = this._content.getBoundingClientRect();

				scrollSections.forEach((section) => {
					const rect = section.getBoundingClientRect();
					const relativeTop = rect.top - contentRect.top;
					// Target the section that has started/passed the top of the viewport (relativeTop <= 60)
					// but is closest to the top of the viewport (i.e. largest relativeTop among those <= 60)
					if (relativeTop <= 60 && relativeTop > maxTopPassed) {
						maxTopPassed = relativeTop;
						const fullId = section.id;
						if (fullId && fullId.startsWith('section-')) {
							activeId = fullId.substring(8);
						}
					}
				});

				if (this._activeSection !== activeId) {
					this._activeSection = activeId;
					this._updateActiveNav(activeId);
				}
			}
		});

		// Force wheel events to scroll the content (bypasses any parent interception)
		contentWrapper.addEventListener('wheel', (e) => {
			this._content.scrollTop += e.deltaY;
			this._content.scrollLeft += e.deltaX;
			e.preventDefault();
			e.stopPropagation();
		}, { passive: false });

		// Update slider on resize
		const resizeObserver = new ResizeObserver(() => updateSlider());
		resizeObserver.observe(this._content);
		this._disposables.add({ dispose: () => resizeObserver.disconnect() });

		const workbench = document.querySelector('.monaco-workbench') || document.body;
		workbench.appendChild(this._overlay);
	}

	private _buildHeader(part: HTMLElement): void {
		const header = document.createElement('div');
		header.className = 'modal-editor-header';

		// Sidebar toggle (hidden)
		const sidebarToggle = document.createElement('div');
		sidebarToggle.className = 'modal-editor-sidebar-toggle';
		sidebarToggle.style.display = 'none';
		sidebarToggle.setAttribute('aria-hidden', 'true');
		const stBar = document.createElement('div');
		stBar.className = 'monaco-action-bar';
		const stActions = document.createElement('ul');
		stActions.className = 'actions-container';
		stActions.setAttribute('role', 'toolbar');
		const stItem = document.createElement('li');
		stItem.className = 'action-item';
		stItem.setAttribute('role', 'presentation');
		stItem.setAttribute('custom-hover', 'true');
		const stBtn = document.createElement('a');
		stBtn.className = 'action-label codicon codicon-layout-sidebar-left';
		stBtn.setAttribute('role', 'button');
		stBtn.setAttribute('aria-label', 'Toggle Sidebar');
		stBtn.tabIndex = 0;
		stItem.appendChild(stBtn);
		stActions.appendChild(stItem);
		stBar.appendChild(stActions);
		sidebarToggle.appendChild(stBar);
		header.appendChild(sidebarToggle);

		// Title
		const title = document.createElement('div');
		title.className = 'modal-editor-title show-file-icons';
		title.id = 'sidex-modal-editor-title';
		const iconLabel = document.createElement('div');
		iconLabel.className = 'monaco-icon-label codicon-settings-editor-label-icon predefined-file-icon';
		iconLabel.setAttribute('aria-label', 'settingseditor');
		iconLabel.setAttribute('custom-hover', 'true');
		const labelContainer = document.createElement('div');
		labelContainer.className = 'monaco-icon-label-container';
		const nameContainer = document.createElement('span');
		nameContainer.className = 'monaco-icon-name-container';
		const labelName = document.createElement('a');
		labelName.className = 'label-name';
		labelName.textContent = 'Settings';
		nameContainer.appendChild(labelName);
		labelContainer.appendChild(nameContainer);
		iconLabel.appendChild(labelContainer);
		title.appendChild(iconLabel);
		header.appendChild(title);

		// Navigation (hidden)
		const nav = document.createElement('div');
		nav.className = 'modal-editor-navigation';
		nav.style.display = 'none';
		nav.setAttribute('aria-hidden', 'true');
		const prevBtn = document.createElement('a');
		prevBtn.className = 'monaco-button codicon codicon-chevron-left modal-editor-nav-button';
		prevBtn.tabIndex = 0;
		prevBtn.setAttribute('role', 'button');
		prevBtn.setAttribute('custom-hover', 'true');
		prevBtn.setAttribute('aria-disabled', 'false');
		prevBtn.setAttribute('aria-label', 'Previous');
		nav.appendChild(prevBtn);
		const navLabel = document.createElement('span');
		navLabel.className = 'modal-editor-nav-label';
		navLabel.setAttribute('aria-live', 'polite');
		nav.appendChild(navLabel);
		const nextBtn = document.createElement('a');
		nextBtn.className = 'monaco-button codicon codicon-chevron-right modal-editor-nav-button';
		nextBtn.tabIndex = 0;
		nextBtn.setAttribute('role', 'button');
		nextBtn.setAttribute('custom-hover', 'true');
		nextBtn.setAttribute('aria-disabled', 'false');
		nextBtn.setAttribute('aria-label', 'Next');
		nav.appendChild(nextBtn);
		header.appendChild(nav);

		// Action container
		const actionContainer = document.createElement('div');
		actionContainer.className = 'modal-editor-action-container';

		// Window actions toolbar
		const toolbar2 = document.createElement('div');
		toolbar2.className = 'monaco-toolbar';
		const actionBar2 = document.createElement('div');
		actionBar2.className = 'monaco-action-bar';
		const actions2 = document.createElement('ul');
		actions2.className = 'actions-container highlight-toggled';
		actions2.setAttribute('role', 'toolbar');

		// Maximize
		const maxItem = document.createElement('li');
		maxItem.className = 'action-item menu-entry';
		maxItem.setAttribute('role', 'presentation');
		maxItem.setAttribute('custom-hover', 'true');
		const maxBtn = document.createElement('a');
		maxBtn.className = 'action-label codicon codicon-screen-full';
		maxBtn.setAttribute('role', 'button');
		maxBtn.setAttribute('aria-label', 'Maximize Modal Editor');
		maxBtn.setAttribute('aria-pressed', 'false');
		maxBtn.tabIndex = -1;
		maxBtn.addEventListener('click', () => {
			this._isMaximized = !this._isMaximized;
			maxBtn.setAttribute('aria-pressed', String(this._isMaximized));
			if (this._isMaximized) {
				maxBtn.classList.remove('codicon-screen-full');
				maxBtn.classList.add('codicon-screen-normal');
				maxBtn.setAttribute('aria-label', 'Restore Modal Editor');
			} else {
				maxBtn.classList.remove('codicon-screen-normal');
				maxBtn.classList.add('codicon-screen-full');
				maxBtn.setAttribute('aria-label', 'Maximize Modal Editor');
			}
			this._layoutResizable();
		});
		maxItem.appendChild(maxBtn);
		actions2.appendChild(maxItem);

		// Close
		const closeItem = document.createElement('li');
		closeItem.className = 'action-item menu-entry';
		closeItem.setAttribute('role', 'presentation');
		closeItem.setAttribute('custom-hover', 'true');
		const closeBtn = document.createElement('a');
		closeBtn.className = 'action-label codicon codicon-close';
		closeBtn.setAttribute('role', 'button');
		closeBtn.setAttribute('aria-label', 'Close Modal Editor (Escape)');
		closeBtn.tabIndex = -1;
		closeBtn.addEventListener('click', () => this.close());
		closeItem.appendChild(closeBtn);
		actions2.appendChild(closeItem);

		actionBar2.appendChild(actions2);
		toolbar2.appendChild(actionBar2);
		actionContainer.appendChild(toolbar2);

		header.appendChild(actionContainer);
		part.appendChild(header);
	}

	private _buildSidebar(part: HTMLElement): void {
		const sidebar = document.createElement('div');
		sidebar.className = 'modal-editor-sidebar';
		sidebar.style.cssText = 'grid-row:2;grid-column:1;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;padding:8px;background-color:var(--vscode-sideBar-background, #181818);border-right:1px solid var(--vscode-sideBarSectionHeader-border, rgba(255,255,255,0.09));width:240px;';

		// Account (First now!)
		this._accountContainer = document.createElement('div');
		this._accountContainer.className = 'sidex-settings-account';
		sidebar.appendChild(this._accountContainer);

		// Search (Second now!)
		const searchContainer = document.createElement('div');
		searchContainer.className = 'sidex-settings-search';
		const searchWrapper = document.createElement('div');
		searchWrapper.className = 'sidex-search-wrapper';
		
		const searchIcon = document.createElement('span');
		searchIcon.className = 'codicon codicon-search';
		searchIcon.style.cssText = 'font-size:12px; opacity:0.5; margin-left:8px; margin-right:4px; flex-shrink:0;';
		searchWrapper.appendChild(searchIcon);

		const searchInput = document.createElement('input');
		searchInput.type = 'text';
		searchInput.placeholder = 'Search settings';
		searchInput.setAttribute('aria-label', 'Search settings');
		searchInput.addEventListener('input', () => this._filterNav(searchInput.value));
		searchWrapper.appendChild(searchInput);
		searchContainer.appendChild(searchWrapper);
		sidebar.appendChild(searchContainer);

		// Nav
		this._navContainer = document.createElement('div');
		this._navContainer.className = 'sidex-settings-nav';
		this._navContainer.setAttribute('role', 'navigation');
		this._navContainer.setAttribute('aria-label', 'Settings Table of Contents');
		this._buildNav();
		sidebar.appendChild(this._navContainer);

		part.appendChild(sidebar);
	}

	private _buildNav(): void {
		this._navContainer.innerHTML = '';
		this._navElements.clear();

		for (const item of NAV_ITEMS) {
			if (item.type === 'separator') {
				const sep = document.createElement('div');
				sep.className = 'sidex-settings-nav-separator';
				this._navContainer.appendChild(sep);
				continue;
			}

			const el = document.createElement('div');
			el.className = 'sidex-settings-nav-item';
			el.dataset.id = item.id!;
			el.setAttribute('role', 'treeitem');
			el.setAttribute('aria-label', item.label!);

			if (item.disabled) {
				el.classList.add('disabled');
				el.setAttribute('aria-disabled', 'true');
			}

			if (item.id === this._activeSection) {
				el.classList.add('active');
				el.setAttribute('aria-selected', 'true');
			} else {
				el.setAttribute('aria-selected', 'false');
			}

			const icon = document.createElement('span');
			icon.className = `codicon ${item.icon}`;
			el.appendChild(icon);

			const label = document.createElement('span');
			label.textContent = item.label!;
			el.appendChild(label);

			if (item.external) {
				const ext = document.createElement('span');
				ext.className = 'sidex-settings-nav-item-external codicon codicon-link-external';
				el.appendChild(ext);
			}

			el.addEventListener('click', () => {
				if (el.classList.contains('disabled')) { return; }
				if (item.external) {
					this._handleExternalNav(item.id!);
					return;
				}
				this.navigateTo(item.id!);
			});

			this._navElements.set(item.id!, el);
			this._navContainer.appendChild(el);
		}
	}

	private _handleExternalNav(id: string): void {
		switch (id) {
			case 'vscode-settings':
				this.close();
				setTimeout(() => {
					try {
						const commandService = (globalThis as any).__sidex_commandService;
						const editorGroupsService = (globalThis as any).__sidex_editorGroupsService;
						if (commandService && editorGroupsService) {
							const mainGroupId = editorGroupsService.mainPart.activeGroup.id;
							commandService.executeCommand('workbench.action.openSettings2', { groupId: mainGroupId });
						} else if (commandService) {
							commandService.executeCommand('workbench.action.openSettings2');
						}
					} catch { /* ignore */ }
				}, 50);
				break;
			case 'marketplace': break;
				break;
			case 'docs':
				// The old docs subdomain is dead and no replacement is hosted yet; the README is the real docs entry point.
				window.open('https://github.com/Sidenai/sidex#readme', '_blank');
				break;
		}
	}

	private _filterNav(query: string): void {
		const lowerQuery = query.toLowerCase();
		for (const [id, el] of this._navElements) {
			const item = NAV_ITEMS.find(n => n.id === id);
			if (!item || !item.label) { continue; }
			const matches = !query || item.label.toLowerCase().includes(lowerQuery);
			el.style.display = matches ? '' : 'none';
		}
	}

	private _bindEvents(): void {
		this._overlay.addEventListener('mousedown', (e) => {
			if (e.target === this._overlay) {
				this.close();
			}
		});

		// Sections ask to jump elsewhere by event rather than importing the
		// panel, which would be a cycle.
		window.addEventListener('sidex-settings-navigate', ((e: CustomEvent<string>) => {
			if (this._isOpen && typeof e.detail === 'string') {
				this.navigateTo(e.detail);
			}
		}) as EventListener);

		const onKeyDown = (e: KeyboardEvent) => {
			if (this._isOpen && e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.close();
			}
		};
		document.addEventListener('keydown', onKeyDown, true);
		this._disposables.add({ dispose: () => document.removeEventListener('keydown', onKeyDown, true) });
	}

	private async _renderAccount(): Promise<void> {
		const invoke = this._getTauriInvoke();
		let session: {
			user: { name: string; email: string; picture: string | null; plan: string };
		} | null = null;

		if (invoke) {
			try {
				session = await invoke('auth_get_session') as typeof session;
			} catch { /* the panel still renders without a profile */ }
		}

		// There is no signed-out state: the profile is the local machine user.
		if (!session) {
			this._accountContainer.innerHTML = '';
			return;
		}

	const user = session.user;

	this._accountContainer.innerHTML = '';
	const info = document.createElement('div');
	info.className = 'sidex-settings-account-info';
	info.style.cssText = 'display:flex;align-items:center;gap:10px;';

	// Create user profile avatar on the left
	const avatar = document.createElement('div');
	avatar.className = 'sidex-settings-account-avatar';
	avatar.style.cssText = 'width:32px;height:32px;border-radius:6px;background:var(--vscode-menu-background, var(--vscode-dropdown-background));color:var(--vscode-foreground, #ccc);font-weight:600;font-size:13px;display:flex;align-items:center;justify-content:center;text-transform:uppercase;flex-shrink:0;user-select:none;';
	
	let initials = '';
	if (user.name && user.name.trim()) {
		const parts = user.name.trim().split(/\s+/);
		if (parts.length >= 2) {
			initials = (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
		} else if (parts.length === 1) {
			initials = parts[0].substring(0, 2).toUpperCase();
		}
	}
	if (!initials && user.email) {
		const cleanEmail = user.email.replace(/[^a-zA-Z0-9]/g, '');
		initials = cleanEmail.substring(0, 2).toUpperCase();
	}
	if (!initials) {
		initials = 'U';
	}
	avatar.textContent = initials;
	info.appendChild(avatar);

	const details = document.createElement('div');
	details.className = 'sidex-settings-account-details';

	const nameEl = document.createElement('div');
	nameEl.className = 'sidex-settings-account-email';
	nameEl.textContent = user.name;
	details.appendChild(nameEl);


	info.appendChild(details);

	this._accountContainer.appendChild(info);
}


	private _updateActiveNav(id: string): void {
		for (const [navId, el] of this._navElements) {
			if (navId === id) {
				el.classList.add('active');
				el.setAttribute('aria-selected', 'true');
			} else {
				el.classList.remove('active');
				el.setAttribute('aria-selected', 'false');
			}
		}
	}

	private _renderSection(): void {
		for (const sec of this._sections) {
			if (sec.dispose) {
				try { sec.dispose(); } catch { /* ignore */ }
			}
		}
		this._sections = [];
		this._content.innerHTML = '';

		const generalSec = new GeneralSection(this._getTauriInvoke());

		// 1. General (Account)
		const generalWrapper = document.createElement('div');
		generalWrapper.id = 'section-general';
		generalWrapper.className = 'sidex-settings-scroll-section';
		this._content.appendChild(generalWrapper);
		generalSec.render(generalWrapper);

		// 2. Plan & Usage
		const planWrapper = document.createElement('div');
		planWrapper.id = 'section-plan-usage';
		planWrapper.className = 'sidex-settings-scroll-section';
		this._content.appendChild(planWrapper);
		const planSec = new PlanUsageSection(this._getTauriInvoke());
		planSec.render(planWrapper);
		this._sections.push(planSec);

		// 3. Models
		const modelsWrapper = document.createElement('div');
		modelsWrapper.id = 'section-models';
		modelsWrapper.className = 'sidex-settings-scroll-section';
		this._content.appendChild(modelsWrapper);
		const modelsSec = new ModelsSection(this._getTauriInvoke());
		modelsSec.render(modelsWrapper);
		this._sections.push(modelsSec);

		// 4. Customizations (Rules)
		const rulesWrapper = document.createElement('div');
		rulesWrapper.id = 'section-rules';
		rulesWrapper.className = 'sidex-settings-scroll-section';
		this._content.appendChild(rulesWrapper);
		const rulesSec = new RulesSection(this._getTauriInvoke());
		rulesSec.render(rulesWrapper);
		this._sections.push(rulesSec);

		// 5. Tools & MCPs
		const toolsWrapper = document.createElement('div');
		toolsWrapper.id = 'section-tools';
		toolsWrapper.className = 'sidex-settings-scroll-section';
		this._content.appendChild(toolsWrapper);
		const toolsSec = new ToolsSection(this._getTauriInvoke());
		toolsSec.render(toolsWrapper);
		this._sections.push(toolsSec);

		// 5b. Configuration
		const configWrapper = document.createElement('div');
		configWrapper.id = 'section-configuration';
		configWrapper.className = 'sidex-settings-scroll-section';
		this._content.appendChild(configWrapper);
		const configSec = new ConfigurationSection(this._getTauriInvoke());
		configSec.render(configWrapper);
		this._sections.push(configSec);

		// 6. Preferences
		const preferencesWrapper = document.createElement('div');
		preferencesWrapper.id = 'section-preferences';
		preferencesWrapper.className = 'sidex-settings-scroll-section';
		this._content.appendChild(preferencesWrapper);
		generalSec.renderPreferences(preferencesWrapper);

		// 7. Notifications
		const notificationsWrapper = document.createElement('div');
		notificationsWrapper.id = 'section-notifications';
		notificationsWrapper.className = 'sidex-settings-scroll-section';
		this._content.appendChild(notificationsWrapper);
		generalSec.renderNotifications(notificationsWrapper);

		// 8. Indexing & Stats
		const indexingWrapper = document.createElement('div');
		indexingWrapper.id = 'section-indexing';
		indexingWrapper.className = 'sidex-settings-scroll-section';
		this._content.appendChild(indexingWrapper);
		const indexingSec = new IndexingSection(this._getTauriInvoke());
		indexingSec.render(indexingWrapper);
		this._sections.push(indexingSec);

		// 9. Privacy (Absolute Bottom)
		const privacyWrapper = document.createElement('div');
		privacyWrapper.id = 'section-privacy';
		privacyWrapper.className = 'sidex-settings-scroll-section';
		this._content.appendChild(privacyWrapper);
		generalSec.renderPrivacy(privacyWrapper);

		this._sections.push(generalSec);
	}

	open(): void {
		if (this._isOpen) { return; }
		this._isOpen = true;
		this._renderAccount();
		this._renderSection();
		this._overlay.style.display = '';
	}

	close(): void {
		if (!this._isOpen) { return; }
		this._isOpen = false;
		this._overlay.style.display = 'none';
	}

	toggle(): void {
		if (this._isOpen) {
			this.close();
		} else {
			this.open();
		}
	}

	isOpen(): boolean {
		return this._isOpen;
	}

	navigateTo(sectionId: string): void {
		const target = this._content.querySelector(`#section-${sectionId}`) as HTMLElement;
		if (target) {
			this._activeSection = sectionId;
			this._updateActiveNav(sectionId);

			this._isScrollingFromClick = true;
			target.scrollIntoView({ behavior: 'smooth', block: 'start' });

			if (this._scrollSpyTimeout) { clearTimeout(this._scrollSpyTimeout); }
			this._scrollSpyTimeout = setTimeout(() => {
				this._isScrollingFromClick = false;
			}, 800);
		}
	}

	override dispose(): void {
		for (const sec of this._sections) {
			if (sec.dispose) {
				try { sec.dispose(); } catch { /* ignore */ }
			}
		}
		this._sections = [];
		this._overlay.remove();
		_instance = null;
		super.dispose();
	}
}
