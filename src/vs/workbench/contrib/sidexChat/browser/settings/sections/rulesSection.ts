/*---------------------------------------------------------------------------------------------
 *  Rules, Skills, Subagents section for SideX Settings panel.
 *  Manage rules, skills, subagent definitions, and slash commands.
 *--------------------------------------------------------------------------------------------*/

import type { SettingsSection } from '../sidexSettingsPanel.js';

type TauriInvoke = ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null;

interface RuleItem {
	id: string;
	name: string;
	scope: 'user' | 'project';
	enabled: boolean;
}

interface SkillItem {
	id: string;
	name: string;
	scope: 'user' | 'project';
}

interface HookItem {
	id: string;
	event: string;
	command: string;
	enabled: boolean;
}

type TabFilter = 'all' | 'user' | 'project';

export class RulesSection implements SettingsSection {
	private _container: HTMLElement | null = null;
	private _invoke: TauriInvoke;
	private _activeTab: TabFilter = 'all';
	private _rules: RuleItem[] = [];
	private _skills: SkillItem[] = [];
	private _hooks: HookItem[] = [];
	private _workspacePath: string = '.';
	private _dynamicCardsWrapper: HTMLElement | null = null;

	constructor(invoke: TauriInvoke) {
		this._invoke = invoke;
	}

	async render(container: HTMLElement): Promise<void> {
		this._container = container;

		if (this._invoke) {
			try {
				const env = await this._invoke('get_env', { name: 'SIDEX_WORKSPACE' }) as string | null;
				if (env) { this._workspacePath = env; }
			} catch { /* use default */ }
		}

		container.innerHTML = '';

		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = 'Rules, Skills & Hooks';
		container.appendChild(title);

		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description sidex-settings-section-desc';
		desc.textContent = 'Provide domain-specific knowledge and workflows for the agent';
		container.appendChild(desc);

		// 1. Render Scope & Integration Card (Static)
		this._renderScopeCard(container);

		// 2. Create Dynamic Cards Wrapper
		this._dynamicCardsWrapper = document.createElement('div');
		this._dynamicCardsWrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
		container.appendChild(this._dynamicCardsWrapper);

		// 3. Render Dynamic Content
		await this._renderDynamicContent();
	}

	private async _renderDynamicContent(): Promise<void> {
		if (!this._dynamicCardsWrapper) { return; }

		// 1. Load data asynchronously first
		await this._loadData();

		// 2. Clear and rebuild synchronously in a single paint frame!
		this._dynamicCardsWrapper.innerHTML = '';

		// Render Rules Card
		const filteredRules = this._filterItems(this._rules);
		this._renderSubsectionCard(this._dynamicCardsWrapper, {
			title: 'Rules',
			description: 'Guide agent behavior (coding standards, practices, conventions)',
			items: filteredRules,
			emptyText: 'No Rules Yet',
			newButtonText: 'New Rule',
			newAction: () => this._createNewRule(),
		});

		// Render Skills Card
		const filteredSkills = this._filterItems(this._skills);
		this._renderSubsectionCard(this._dynamicCardsWrapper, {
			title: 'Skills',
			description: 'Specialized capabilities that help the agent accomplish specific tasks',
			items: filteredSkills,
			emptyText: 'No Skills Yet',
			newButtonText: 'New Skill',
			newAction: () => this._createNewSkill(),
		});

		// Render Hooks Card
		this._renderHooksCard(this._dynamicCardsWrapper);
	}

	private async _loadData(): Promise<void> {
		if (!this._invoke) { return; }

		this._rules = [];
		this._skills = [];

		// Load rules from .sidex/rules/ directory
		try {
			const rulesDir = await this._invoke('read_dir', { path: this._workspacePath + '/.sidex/rules' }) as { entries: { name: string; is_dir: boolean }[] } | null;
			if (rulesDir && rulesDir.entries) {
				this._rules = rulesDir.entries
					.filter(e => !e.is_dir && (e.name.endsWith('.md') || e.name.endsWith('.mdc')))
					.map(e => ({
						id: e.name,
						name: e.name.replace(/\.(md|mdc)$/, ''),
						scope: 'project' as const,
						enabled: true,
					}));
			}
		} catch { /* no rules dir */ }

		// Also check user-level rules
		try {
			const homeRules = await this._invoke('read_dir', { path: '~/.sidex/rules' }) as { entries: { name: string; is_dir: boolean }[] } | null;
			if (homeRules && homeRules.entries) {
				const userRules = homeRules.entries
					.filter(e => !e.is_dir && (e.name.endsWith('.md') || e.name.endsWith('.mdc')))
					.map(e => ({
						id: '~/.sidex/rules/' + e.name,
						name: e.name.replace(/\.(md|mdc)$/, ''),
						scope: 'user' as const,
						enabled: true,
					}));
				this._rules = [...this._rules, ...userRules];
			}
		} catch { /* no user rules */ }

		// Load skills from .sidex/skills/ directory
		try {
			const skillsDir = await this._invoke('read_dir', { path: this._workspacePath + '/.sidex/skills' }) as { entries: { name: string; is_dir: boolean }[] } | null;
			if (skillsDir && skillsDir.entries) {
				this._skills = skillsDir.entries
					.filter(e => !e.is_dir || e.name !== '__pycache__')
					.map(e => ({
						id: e.name,
						name: e.name.replace(/\.(md|mdc)$/, ''),
						scope: 'project' as const,
					}));
			}
		} catch { /* no skills dir */ }

		// Load hooks via hooks_list
		try {
			const hooksData = await this._invoke('hooks_list') as HookItem[] | null;
			if (hooksData) { this._hooks = hooksData; }
		} catch { /* no hooks */ }
	}

	private _renderScopeCard(container: HTMLElement): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';

		// Row 1: Rules Scope Segmented Selector
		const scopeRow = this._createRow(card, 'Rules scope', 'Filter rules and skills by user or project scope');
		this._addScopeSegmentedControl(scopeRow);

		// Row 2: Include third-party integrations
		const integrateRow = this._createRow(card, 'Include third-party Plugins, Skills, and other configs', 'Auto import from other tools');
		this._addToggle(integrateRow, true, 'sidex.rules.includeThirdParty');

		container.appendChild(card);
	}

	private _addScopeSegmentedControl(row: HTMLElement): void {
		const control = document.createElement('div');
		control.className = 'sidex-settings-segmented-control';

		const tabs: { id: TabFilter; label: string }[] = [
			{ id: 'all', label: 'All' },
			{ id: 'user', label: 'User' },
			{ id: 'project', label: 'Project' },
		];

		for (const tab of tabs) {
			const btn = document.createElement('button');
			btn.className = 'sidex-settings-segment-btn';
			btn.textContent = tab.label;

			if (tab.id === this._activeTab) {
				btn.classList.add('active');
			}

			btn.addEventListener('click', () => {
				this._activeTab = tab.id;
				
				// Update active button styles on the fly without re-creating Card 1!
				const buttons = control.querySelectorAll('.sidex-settings-segment-btn');
				buttons.forEach(b => {
					b.classList.remove('active');
				});
				btn.classList.add('active');

				this._renderDynamicContent();
			});
			control.appendChild(btn);
		}

		row.querySelector('.sidex-settings-row-action')!.appendChild(control);
	}

	private _renderSubsectionCard(container: HTMLElement, opts: {
		title: string;
		description: string;
		items: { id: string; name: string }[];
		emptyText: string;
		newButtonText?: string;
		newAction?: () => void;
	}): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';

		// Create Header Row
		const headerRow = this._createRow(card, opts.title, opts.description);
		if (opts.newButtonText && opts.newAction) {
			const actionContainer = headerRow.querySelector('.sidex-settings-row-action')!;
			const newBtn = document.createElement('button');
			newBtn.className = 'sidex-settings-btn';
			newBtn.textContent = opts.newButtonText;
			newBtn.addEventListener('click', opts.newAction);
			actionContainer.appendChild(newBtn);
		}

		// List items
		if (opts.items.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'sidex-settings-empty-state';
			empty.textContent = opts.emptyText;
			card.appendChild(empty);
		} else {
			for (const item of opts.items) {
				const row = this._createRow(card, item.name);
				const action = row.querySelector('.sidex-settings-row-action')!;
				const editBtn = document.createElement('button');
				editBtn.className = 'sidex-settings-btn';
				editBtn.textContent = 'Edit';
				editBtn.addEventListener('click', () => {
					window.dispatchEvent(new CustomEvent('sidex-open-file', { detail: { path: item.id } }));
				});
				action.appendChild(editBtn);
			}
		}

		container.appendChild(card);
	}

	private _renderHooksCard(container: HTMLElement): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';

		// Create Header Row
		this._createRow(card, 'Hooks', 'Lifecycle hooks that trigger on agent events');

		if (this._hooks.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'sidex-settings-empty-state';
			empty.textContent = 'No hooks configured. Manage hooks in the Hooks settings section.';
			card.appendChild(empty);
		} else {
			for (const hook of this._hooks) {
				const row = this._createRow(card, hook.event, hook.command);
				const action = row.querySelector('.sidex-settings-row-action')!;
				const statusEl = document.createElement('span');
				statusEl.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);font-weight:500;';
				statusEl.textContent = hook.enabled ? 'Enabled' : 'Disabled';
				action.appendChild(statusEl);
			}
		}

		container.appendChild(card);
	}

	private _filterItems<T extends { scope: string }>(items: T[]): T[] {
		if (this._activeTab === 'all') { return items; }
		return items.filter(i => i.scope === this._activeTab);
	}

	private _createNewRule(): void {
		if (!this._invoke) { return; }
		const filename = `new-rule-${Date.now()}.md`;
		const scope = this._activeTab === 'user' ? 'user' : 'project';
		const parentDir = scope === 'project'
			? `${this._workspacePath}/.sidex/rules`
			: `~/.sidex/rules`;
		const path = `${parentDir}/${filename}`;

		const template = `---\ndescription: New rule\nglobs: \n---\n\n# Rule Name\n\nDescribe your rule here.\n`;

		this._invoke('mkdir', { path: parentDir, recursive: true }).then(() => {
			if (this._invoke) {
				this._invoke('write_file', { path, contents: template }).then(() => {
					window.dispatchEvent(new CustomEvent('sidex-open-file', { detail: { path } }));
					this._renderDynamicContent();
				}).catch(() => {});
			}
		}).catch(() => {});
	}

	private _createNewSkill(): void {
		if (!this._invoke) { return; }
		const filename = `new-skill-${Date.now()}.md`;
		const parentDir = `${this._workspacePath}/.sidex/skills`;
		const path = `${parentDir}/${filename}`;

		const template = `# Skill Name\n\nDescribe what this skill does and when to use it.\n`;

		this._invoke('mkdir', { path: parentDir, recursive: true }).then(() => {
			if (this._invoke) {
				this._invoke('write_file', { path, contents: template }).then(() => {
					window.dispatchEvent(new CustomEvent('sidex-open-file', { detail: { path } }));
					this._renderDynamicContent();
				}).catch(() => {});
			}
		}).catch(() => {});
	}

	private _createRow(parent: HTMLElement, label: string, description?: string): HTMLElement {
		const row = document.createElement('div');
		row.className = 'sidex-settings-row';

		const left = document.createElement('div');
		const lbl = document.createElement('div');
		lbl.className = 'sidex-settings-row-label';
		lbl.textContent = label;
		left.appendChild(lbl);

		if (description) {
			const desc = document.createElement('div');
			desc.className = 'sidex-settings-row-description';
			desc.textContent = description;
			left.appendChild(desc);
		}
		row.appendChild(left);

		const action = document.createElement('div');
		action.className = 'sidex-settings-row-action';
		row.appendChild(action);

		parent.appendChild(row);
		return row;
	}

	private _addToggle(row: HTMLElement, initialState: boolean, settingKey: string): HTMLElement {
		const toggle = document.createElement('div');
		toggle.className = 'sidex-settings-toggle' + (initialState ? ' on' : '');

		if (this._invoke) {
			this._invoke('settings_get', { section: settingKey }).then((val) => {
				if (val === true) { toggle.classList.add('on'); }
				else if (val === false) { toggle.classList.remove('on'); }
			}).catch(() => {});
		}

		toggle.addEventListener('click', () => {
			toggle.classList.toggle('on');
			const value = toggle.classList.contains('on');
			if (this._invoke) {
				this._invoke('settings_update', { key: settingKey, value: JSON.stringify(value), scope: 'user' }).catch(() => {});
			}
		});
		row.querySelector('.sidex-settings-row-action')!.appendChild(toggle);
		return toggle;
	}

	dispose(): void {
		this._container = null;
	}
}
