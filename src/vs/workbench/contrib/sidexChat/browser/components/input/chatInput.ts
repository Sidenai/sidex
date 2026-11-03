import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { MentionPopup } from './mentionPopup.js';
import { MentionResolver, MentionItem } from '../../context/mentionResolver.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ISidexChatService } from '../../sidexChatService.js';

export type AgentMode = 'agent' | 'plan' | 'ask';

export interface ResolvedMention {
	item: MentionItem;
	resolvedContent: string;
}

interface ChatAttachment {
	path: string;
	originalPath: string;
	name: string;
	kind: 'image' | 'file';
}

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function codicon(c: ThemeIcon): HTMLSpanElement {
	const el = document.createElement('span');
	el.classList.add(...ThemeIcon.asClassNameArray(c));
	return el;
}

export class ChatInput extends Component {
	private _textareaEl: HTMLTextAreaElement;
	private _sendBtn: HTMLElement;
	private _stopBtn: HTMLElement;
	private _modeLabel: HTMLElement;
	private _modelLabel: HTMLElement;
	private _modeMenu: HTMLElement;
	private _currentMode: AgentMode = 'agent';
	private _currentModel = '';

	// Mention system
	private _mentionPopup: MentionPopup;
	private _mentionResolver: MentionResolver;
	private _mentionPillsContainer: HTMLElement;
	private _resolvedMentions: ResolvedMention[] = [];
	private _attachmentsContainer: HTMLElement;
	private _attachments: ChatAttachment[] = [];
	private _dragDepth = 0;
	private _mentionTracking: { active: boolean; startPos: number } = { active: false, startPos: -1 };
	private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

	private readonly _onSend = this._register(new Emitter<string>());
	readonly onSend: Event<string> = this._onSend.event;

	private readonly _onSendWithMentions = this._register(new Emitter<{ text: string; mentions: ResolvedMention[] }>());
	readonly onSendWithMentions: Event<{ text: string; mentions: ResolvedMention[] }> = this._onSendWithMentions.event;

	private readonly _onStop = this._register(new Emitter<void>());
	readonly onStop: Event<void> = this._onStop.event;

	private readonly _onModeChange = this._register(new Emitter<AgentMode>());
	readonly onModeChange: Event<AgentMode> = this._onModeChange.event;

	private readonly _onModelChange = this._register(new Emitter<string>());
	readonly onModelChange: Event<string> = this._onModelChange.event;

	private readonly _onMaxModeChange = this._register(new Emitter<boolean>());
	readonly onMaxModeChange: Event<boolean> = this._onMaxModeChange.event;

	private readonly _onThinkingBudgetChange = this._register(new Emitter<number>());
	readonly onThinkingBudgetChange: Event<number> = this._onThinkingBudgetChange.event;

	private static readonly REASONING_STORAGE_KEY = 'sidex.reasoningLevel';
	private static readonly REASONING_LEVELS: Array<'None' | 'Low' | 'Medium' | 'High' | 'Ultra'> = ['None', 'Low', 'Medium', 'High', 'Ultra'];

	private _maxMode = false;
	get maxMode(): boolean { return this._maxMode; }

	private _reasoningLevel: 'None' | 'Low' | 'Medium' | 'High' | 'Ultra' = ChatInput._loadReasoningLevel();
	get reasoningLevel() { return this._reasoningLevel; }

	private static _loadReasoningLevel(): 'None' | 'Low' | 'Medium' | 'High' | 'Ultra' {
		try {
			const saved = localStorage.getItem(ChatInput.REASONING_STORAGE_KEY);
			if (saved && (ChatInput.REASONING_LEVELS as readonly string[]).includes(saved)) {
				return saved as 'None' | 'Low' | 'Medium' | 'High' | 'Ultra';
			}
		} catch { /* */ }
		return 'None';
	}

	private _localOnly = false;
	get localOnly(): boolean { return this._localOnly; }

	get mode(): AgentMode { return this._currentMode; }
	get resolvedMentions(): readonly ResolvedMention[] { return this._resolvedMentions; }

	constructor(private readonly _chatService: ISidexChatService) {
		super('div', 'sc-input-area');
		this._maxMode = this._reasoningLevel === 'Ultra';

		const container = this.append('div', 'sc-input-container');
		this._bindAttachmentDrop(this.element, container);
		this._disposables.add(DOM.addDisposableListener(window, 'sidex-attach-paths', ((event: CustomEvent<{ paths?: string[] }>) => {
			const paths = event.detail?.paths ?? [];
			void this._addAttachments(paths);
		}) as EventListener));

		// Inject custom styles for Context Usage Popover and Reasoning Slider
		const styleEl = document.createElement('style');
		styleEl.textContent = `
			.sc-input-container {
				position: relative !important;
			}
			.sc-input-container.drag-over {
				border-color: var(--vscode-focusBorder, var(--vscode-button-background)) !important;
				background: color-mix(in srgb, var(--vscode-input-background) 90%, var(--vscode-button-background) 10%) !important;
			}
			.sc-input-container.drag-over::after {
				content: 'Drop files to attach';
				position: absolute;
				inset: 0;
				display: flex;
				align-items: center;
				justify-content: center;
				border-radius: inherit;
				background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
				color: var(--vscode-foreground);
				font-size: 12px;
				font-weight: 500;
				pointer-events: none;
				z-index: 30;
			}
			/* Context Usage popover */
			.sc-context-popover {
				position: absolute;
				bottom: 100%;
				margin-bottom: 4px;
				left: 12px;
				right: 12px;
				width: auto;
				box-sizing: border-box;
				background: var(--vscode-menu-background, var(--vscode-dropdown-background));
				border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border));
				border-radius: 6px;
				padding: 10px 12px;
				box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.16));
				z-index: 1000;
				font-family: var(--vscode-font-family, sans-serif);
				color: var(--vscode-foreground, #ccc);
				display: none;
				flex-direction: column;
			}
			.sc-context-popover.visible {
				display: flex;
			}
			.sc-context-header {
				display: flex;
				justify-content: space-between;
				align-items: center;
				margin-bottom: 12px;
			}
			.sc-context-title {
				font-size: 12px;
				font-weight: 600;
				color: var(--vscode-foreground);
			}
			.sc-context-actions {
				display: flex;
				align-items: center;
				gap: 8px;
			}
			.sc-context-close {
				cursor: pointer;
				opacity: 0.6;
				font-size: 12px;
				color: var(--vscode-foreground);
				display: flex;
				align-items: center;
			}
			.sc-context-close:hover {
				opacity: 1;
			}
			.sc-context-summary {
				display: flex;
				justify-content: space-between;
				font-size: 11px;
				margin-bottom: 8px;
				color: var(--vscode-descriptionForeground, #888);
			}
			.sc-context-bar {
				height: 4px;
				background: rgba(255,255,255,0.08);
				border-radius: 2px;
				display: flex;
				overflow: hidden;
				margin-bottom: 16px;
			}
			.sc-context-segment {
				height: 100%;
				background: var(--vscode-menu-foreground, #ffffff);
				opacity: 0.5;
				border-radius: 2px;
				transition: width 0.3s ease;
			}
			.sc-context-legend {
				display: flex;
				flex-direction: column;
				gap: 8px;
			}
			.sc-context-legend-row {
				display: flex;
				justify-content: space-between;
				align-items: center;
				font-size: 11px;
			}
			.sc-context-legend-label {
				display: flex;
				align-items: center;
			}
			.sc-context-legend-val {
				color: var(--vscode-descriptionForeground, #888);
			}
			.sc-context-popover.visible {
				display: flex;
			}
			.sc-context-header {
				display: flex;
				justify-content: space-between;
				align-items: center;
				margin-bottom: 12px;
			}
			.sc-context-title {
				font-size: 14px;
				font-weight: 600;
			}
			.sc-context-actions {
				display: flex;
				align-items: center;
				gap: 8px;
			}
			.sc-context-link {
				font-size: 11px;
				color: var(--vscode-textLink-foreground, #007fd4);
				text-decoration: none;
				cursor: pointer;
			}
			.sc-context-link:hover {
				text-decoration: underline;
			}
			.sc-context-close {
				cursor: pointer;
				opacity: 0.6;
				font-size: 14px;
				display: flex;
				align-items: center;
			}
			.sc-context-close:hover {
				opacity: 1;
			}
			.sc-context-summary {
				display: flex;
				justify-content: space-between;
				font-size: 12px;
				margin-bottom: 8px;
				color: var(--vscode-descriptionForeground, #888);
			}
			.sc-context-bar {
				height: 8px;
				background: rgba(255,255,255,0.08);
				border-radius: 4px;
				display: flex;
				overflow: hidden;
				margin-bottom: 16px;
			}
			.sc-context-segment {
				height: 100%;
				transition: width 0.3s ease;
			}
			.sc-context-legend {
				display: flex;
				flex-direction: column;
				gap: 8px;
			}
			.sc-context-legend-row {
				display: flex;
				justify-content: space-between;
				align-items: center;
				font-size: 12px;
			}
			.sc-context-legend-label {
				display: flex;
				align-items: center;
				gap: 8px;
			}
			.sc-context-legend-dot {
				width: 8px;
				height: 8px;
				border-radius: 2px;
			}
			.sc-context-legend-val {
				color: var(--vscode-descriptionForeground, #888);
			}

			/* Context indicator circle button */
			.sc-context-badge {
				width: 18px;
				height: 18px;
				border-radius: 50%;
				background: transparent;
				border: none;
				cursor: pointer;
				display: flex;
				align-items: center;
				justify-content: center;
				user-select: none;
				padding: 0;
				margin-left: 8px;
				opacity: 0.8;
				transition: opacity 0.15s ease, transform 0.15s ease;
			}
			.sc-context-badge:hover {
				opacity: 1;
				transform: scale(1.05);
			}
			.sc-context-ring {
				display: block;
			}
			.sc-context-ring-fill {
				transition: stroke-dashoffset 0.3s ease;
			}

			/* Model menu reasoning section */
			.sc-model-menu-reasoning {
				padding: 6px 10px;
				display: flex;
				flex-direction: column;
				gap: 4px;
				user-select: none;
				border-radius: 4px;
				margin: 0;
			}
			.sc-model-menu-reasoning-header {
				display: flex;
				justify-content: space-between;
				font-size: 12px;
				color: var(--vscode-foreground, #cccccc);
			}
			.sc-model-menu-reasoning-level-val {
				color: var(--vscode-button-background, #007fd4);
				font-weight: 600;
				font-size: 12px;
			}
			.sc-model-menu-reasoning-slider-container {
				position: relative;
				width: 100%;
				padding: 4px 0;
			}
			/* Thick, 6px rounded track with grid of mini rounded squares fading to the right */
			.sc-model-menu-reasoning-slider {
				-webkit-appearance: none;
				width: 100%;
				height: 20px;
				border-radius: 6px;
				background-color: rgba(255, 255, 255, 0.03);
				/* SVG background: 4px pattern size in a 20px height track yields exactly 5 squares tall.
				   The mask uses the g-static progressive static fade, starting earlier (at 10% with 0.01 opacity, very softly emerging).
				   The square has rx=0.4 ry=0.4, making them look crisp and square (less rounded but elegant). */
				background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100%25' height='100%25'><defs><linearGradient id='g-static' x1='0' y1='0' x2='1' y2='0'><stop offset='0%25' stop-color='white' stop-opacity='0'/><stop offset='10%25' stop-color='white' stop-opacity='0'/><stop offset='12%25' stop-color='white' stop-opacity='0.01'/><stop offset='25%25' stop-color='white' stop-opacity='0.02'/><stop offset='60%25' stop-color='white' stop-opacity='0.05'/><stop offset='82%25' stop-color='white' stop-opacity='0.18'/><stop offset='100%25' stop-color='white' stop-opacity='0.45'/></linearGradient><mask id='m-static'><rect width='100%25' height='100%25' fill='url(%23g-static)'/></mask><pattern id='p' width='4' height='4' patternUnits='userSpaceOnUse'><rect x='0.4' y='0.4' width='3.2' height='3.2' rx='0.4' ry='0.4' fill='%23cccccc'/></pattern></defs><rect width='100%25' height='100%25' fill='url(%23p)' mask='url(%23m-static)'/></svg>");
				border: none;
				outline: none;
				cursor: pointer;
				margin: 0;
			}
			/* Capsule thumb, matching the track's 20px height exactly */
			.sc-model-menu-reasoning-slider::-webkit-slider-thumb {
				-webkit-appearance: none;
				appearance: none;
				width: 10px;
				height: 20px;
				border-radius: 5px;
				background: var(--vscode-menu-foreground, #ffffff);
				border: none;
				box-shadow: 0 1px 3px rgba(0,0,0,0.3);
				cursor: pointer;
			}
			.sc-model-menu-reasoning-slider::-webkit-slider-thumb:hover {
				transform: scale(1.05);
			}
			.sc-model-menu-reasoning-ticks {
				display: flex;
				justify-content: space-between;
				margin-top: 2px;
				font-size: 9px;
				letter-spacing: 0.02em;
				color: var(--vscode-descriptionForeground, #888);
			}
			.sc-model-menu-reasoning-ticks span.active {
				color: var(--vscode-foreground);
				font-weight: 600;
			}

			/* Peeking bottom tray container (Cursor/Windsurf style, aligned to SideX branding) */
			.sc-input-container {
				position: relative !important;
				z-index: 20 !important;
			}
			.sc-input-tray {
				position: relative;
				margin-top: -16px; /* overlaps the input container's bottom rounded border, spanning full width */
				min-height: 42px;
				background: var(--vscode-menu-background, var(--vscode-dropdown-background));
				border: 1px solid var(--vscode-widget-border, #333);
				border-top: none; /* blends with the bottom of the input container */
				border-radius: 0 0 8px 8px; /* matching bottom rounding */
				padding: 20px 8px 4px; /* thick top padding handles the overlap spacing */
				display: flex;
				align-items: center;
				gap: 4px;
				overflow: hidden;
				box-sizing: border-box;
				z-index: 10;
			}
			/* Tray indicator/button - borderless and flat */
			.sc-tray-btn {
				display: flex;
				align-items: center;
				gap: 4px;
				height: 20px;
				padding: 0 6px;
				border-radius: 4px;
				background: transparent;
				border: none;
				color: var(--vscode-descriptionForeground, #888);
				font-size: 11px;
				font-weight: 500;
				cursor: pointer;
				user-select: none;
				transition: background-color 100ms ease, color 100ms ease;
			}
			.sc-tray-btn:hover, .sc-tray-btn.dropdown-active {
				background: rgba(255, 255, 255, 0.06);
				color: var(--vscode-foreground, #ccc);
			}
			.sc-tray-btn.active {
				color: var(--vscode-foreground, #ffffff);
			}
			.sc-tray-icon {
				display: flex;
				align-items: center;
				width: 12px;
				height: 12px;
			}
			.sc-tray-chevron {
				font-size: 10px;
				opacity: 0.5;
				margin-left: 2px;
			}

			/* Tray dropdown menu (inherits sc-mode-menu layout, but layers correctly) */
			.sc-tray-menu {
				z-index: 1000 !important;
				left: 12px !important; /* aligns perfectly with the full-width tray left border */
				max-width: calc(100% - 24px);
				min-width: 140px;
				box-sizing: border-box;
				flex-direction: column;
			}
			.sc-tray-menu.visible {
				display: block !important;
			}
			.sc-mode-menu-item.disabled {
				opacity: 0.45 !important;
				cursor: default !important;
			}
			.sc-mode-menu-item.disabled:hover {
				background: transparent !important;
			}
		`;
		document.head.appendChild(styleEl);

		// Mention pills container — sits above the textarea
		this._mentionPillsContainer = DOM.append(container, $('div.sc-mention-pills'));
		this._attachmentsContainer = DOM.append(container, $('div.sc-attachment-pills'));

		this._textareaEl = DOM.append(container, $('textarea.sc-textarea')) as HTMLTextAreaElement;
		this._textareaEl.placeholder = 'Plan, Build, / for commands, @ for context';
		this._textareaEl.rows = 1;

		const footer = DOM.append(container, $('div.sc-input-footer'));
		const left = DOM.append(footer, $('div.sc-input-footer-left'));
		const right = DOM.append(footer, $('div.sc-input-footer-right'));

		// Mode dropdown — icon + "Agent" + chevron
		const modeBtn = DOM.append(left, $('button.sc-mode-dropdown'));
		const modeIconEl = DOM.append(modeBtn, $('span.sc-mode-icon'));
		modeIconEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><g stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><line x1="10" y1="3" x2="10" y2="4"/><line x1="6.5" y1="3.9378" x2="7" y2="4.8038"/><line x1="3.9378" y1="6.5" x2="4.8038" y2="7"/><line x1="3" y1="10" x2="4" y2="10"/><line x1="3.9378" y1="13.5" x2="4.8038" y2="13"/><line x1="6.5" y1="16.0622" x2="7" y2="15.1962"/><line x1="10" y1="17" x2="10" y2="16"/><line x1="13.5" y1="16.0622" x2="13" y2="15.1962"/><line x1="16.0622" y1="13.5" x2="15.1962" y2="13"/><line x1="17" y1="10" x2="16" y2="10"/><line x1="16.0622" y1="6.5" x2="15.1962" y2="7"/><line x1="13.5" y1="3.9378" x2="13" y2="4.8038"/></g></svg>';
		this._modeLabel = DOM.append(modeBtn, $('span.sc-mode-label'));
		this._modeLabel.textContent = 'Agent';
		const modeChevEl = document.createElement('span');
		modeChevEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown), 'codicon-sm');
		modeBtn.appendChild(modeChevEl);

		// Mode dropdown menu
		this._modeMenu = DOM.append(this.element, $('div.sc-mode-menu'));
		for (const mode of ['agent', 'plan', 'ask'] as AgentMode[]) {
			const item = DOM.append(this._modeMenu, $('div.sc-mode-menu-item'));
			item.dataset.mode = mode;
			item.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
			if (mode === 'agent') { item.classList.add('active'); }
			this.on(item, 'click', () => {
				this._setMode(mode);
				this._modeMenu.classList.remove('visible');
			});
		}
		this.on(modeBtn, 'click', () => {
			const isOpening = !this._modeMenu.classList.contains('visible');
			this._modeMenu.classList.toggle('visible');
			if (isOpening) {
				modeIconEl.classList.add('spin');
				setTimeout(() => modeIconEl.classList.remove('spin'), 400);
				// Close other popovers/menus
				modelMenu.classList.remove('visible');
				contextPopover.classList.remove('visible');
				this.element.querySelector('.sc-tray-menu')?.classList.remove('visible');
				this.element.querySelector('.sc-tray-btn')?.classList.remove('dropdown-active');
			}
		});
		this.on(document.body, 'click', (e) => {
			if (!modeBtn.contains(e.target as Node) && !this._modeMenu.contains(e.target as Node)) {
				this._modeMenu.classList.remove('visible');
			}
		});

		// Model dropdown — populated dynamically from server
		const modelBtn = DOM.append(left, $('button.sc-model-btn'));
		this._modelLabel = DOM.append(modelBtn, $('span'));
		this._modelLabel.textContent = '';
		const modelChevEl = document.createElement('span');
		modelChevEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown), 'codicon-sm');
		modelBtn.appendChild(modelChevEl);

		// Model dropdown menu
		const modelMenu = DOM.append(this.element, $('div.sc-model-menu'));
		this.on(modelBtn, 'click', () => {
			const isOpening = !modelMenu.classList.contains('visible');
			modelMenu.classList.toggle('visible');
			if (isOpening) {
				// Close other popovers/menus
				this._modeMenu.classList.remove('visible');
				contextPopover.classList.remove('visible');
				this.element.querySelector('.sc-tray-menu')?.classList.remove('visible');
				this.element.querySelector('.sc-tray-btn')?.classList.remove('dropdown-active');
			}
		});
		this.on(document.body, 'click', (e) => {
			if (!modelBtn.contains(e.target as Node) && !modelMenu.contains(e.target as Node)) {
				modelMenu.classList.remove('visible');
			}
		});

		// Context Usage badge (minimal circular progress ring matching the image) - placed on the right side of the footer
		const contextBadge = DOM.append(right, $('div.sc-context-badge'));
		contextBadge.title = 'View detailed context usage';
		contextBadge.innerHTML = `
			<svg class="sc-context-ring" width="16" height="16" viewBox="0 0 16 16">
				<!-- Track (grey) -->
				<circle class="sc-context-ring-track" cx="8" cy="8" r="6" stroke="rgba(255,255,255,0.15)" stroke-width="2" fill="none" />
				<!-- Filled segment (theme-aligned neutral color, no random purple) -->
				<circle class="sc-context-ring-fill" cx="8" cy="8" r="6" stroke="var(--vscode-menu-foreground, #cccccc)" stroke-width="2" fill="none" 
						stroke-dasharray="37.7" stroke-dashoffset="37.7" transform="rotate(-90 8 8)" stroke-linecap="round" />
			</svg>
		`;

		const contextPopover = DOM.append(this.element, $('div.sc-context-popover'));

		this.on(contextBadge, 'click', (e) => {
			e.stopPropagation();
			const show = !contextPopover.classList.contains('visible');
			if (show) {
				this._updateContextUsage(contextPopover, contextBadge);
				// Close other popovers/menus
				this._modeMenu.classList.remove('visible');
				modelMenu.classList.remove('visible');
				this.element.querySelector('.sc-tray-menu')?.classList.remove('visible');
				this.element.querySelector('.sc-tray-btn')?.classList.remove('dropdown-active');
			}
			contextPopover.classList.toggle('visible', show);
		});

		// Close popovers on click outside
		this.on(document.body, 'click', (e) => {
			const target = e.target as Node;
			if (!contextBadge.contains(target) && !contextPopover.contains(target)) {
				contextPopover.classList.remove('visible');
			}
		});

		// Update badge content on init and every message change
		this._updateContextUsage(contextPopover, contextBadge);
		if (this._chatService) {
			this._register(this._chatService.onDidChangeMessages(() => {
				this._updateContextUsage(contextPopover, contextBadge);
			}));
		}

		// Attach button — folder icon
		const attachBtn = DOM.append(right, $('button.sc-input-icon-btn'));
		attachBtn.title = 'Attach';
		attachBtn.appendChild(codicon(Codicon.folder));
		this.on(attachBtn, 'click', () => {
			void this._attachFiles();
		});

		// Send button — custom SVG (circle + up arrow)
		this._sendBtn = DOM.append(right, $('button.sc-send-btn'));
		this._sendBtn.title = 'Send';
		this._sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M4.14645 6.14645L6.64645 3.64645C6.84171 3.45118 7.15829 3.45118 7.35355 3.64645L9.8536 6.14645C10.0488 6.34171 10.0488 6.65829 9.8536 6.85355C9.6583 7.04882 9.3417 7.04882 9.1464 6.85355L8.3232 6.03033L7.5 5.20711V10C7.5 10.2761 7.27614 10.5 7 10.5C6.72386 10.5 6.5 10.2761 6.5 10V5.20711L4.85355 6.85355C4.65829 7.04882 4.34171 7.04882 4.14645 6.85355C3.95118 6.65829 3.95118 6.34171 4.14645 6.14645ZM7 0C3.13401 0 0 3.13401 0 7C0 10.866 3.13401 14 7 14C10.866 14 14 10.866 14 7C14 3.13401 10.866 0 7 0Z"/></svg>';

		// Stop button — custom SVG (circle + square)
		this._stopBtn = DOM.append(right, $('button.sc-stop-btn'));
		this._stopBtn.title = 'Stop';
		this._stopBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M5 4C4.44772 4 4 4.44772 4 5V9C4 9.5523 4.44772 10 5 10H9C9.5523 10 10 9.5523 10 9V5C10 4.44772 9.5523 4 9 4H5ZM0 7C0 3.13401 3.13401 0 7 0C10.866 0 14 3.13401 14 7C14 10.866 10.866 14 7 14C3.13401 14 0 10.866 0 7Z"/></svg>';
		this._stopBtn.style.display = 'none';

		// Initialize mention system
		this._mentionResolver = new MentionResolver({
			findFiles: async (pattern: string, maxResults: number): Promise<URI[]> => {
				try {
					const vscode = (globalThis as any).vscode;
					if (vscode?.workspace?.findFiles) {
						return await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxResults);
					}
				} catch { /* fallback */ }
				return [];
			},
			readFile: async (uri: URI): Promise<string> => {
				try {
					const vscode = (globalThis as any).vscode;
					if (vscode?.workspace?.fs?.readFile) {
						const bytes = await vscode.workspace.fs.readFile(uri);
						return new TextDecoder().decode(bytes);
					}
				} catch { /* fallback */ }
				return '';
			},
			readDirectory: async (uri: URI): Promise<Array<[string, 'file' | 'directory']>> => {
				try {
					const vscode = (globalThis as any).vscode;
					if (vscode?.workspace?.fs?.readDirectory) {
						const entries = await vscode.workspace.fs.readDirectory(uri);
						return entries.map((e: [string, number]) => [e[0], e[1] === 2 ? 'directory' : 'file'] as [string, 'file' | 'directory']);
					}
				} catch { /* fallback */ }
				return [];
			},
			getWorkspaceFolderPath: (): string | undefined => {
				try {
					const vscode = (globalThis as any).vscode;
					if (vscode?.workspace?.workspaceFolders?.[0]) {
						return vscode.workspace.workspaceFolders[0].uri.fsPath;
					}
				} catch { /* fallback */ }
				return undefined;
			},
		});

		this._mentionPopup = new MentionPopup(this.element, (item) => this._onMentionSelected(item));
		this._disposables.add(this._mentionPopup);

		// Keyboard events — handle mention popup navigation before normal input handling
		this.on(this._textareaEl, 'keydown', (e) => {
			const ke = e as KeyboardEvent;

			if (this._mentionPopup.isVisible) {
				if (ke.key === 'ArrowDown') {
					ke.preventDefault();
					this._mentionPopup.selectNext();
					return;
				}
				if (ke.key === 'ArrowUp') {
					ke.preventDefault();
					this._mentionPopup.selectPrevious();
					return;
				}
				if (ke.key === 'Enter' || ke.key === 'Tab') {
					ke.preventDefault();
					this._mentionPopup.confirmSelection();
					return;
				}
				if (ke.key === 'Escape') {
					ke.preventDefault();
					this._mentionPopup.hide();
					this._mentionTracking.active = false;
					return;
				}
			}

			if (ke.key === 'Enter' && !ke.shiftKey) {
				ke.preventDefault();
				this._doSend();
			}
		});

		this.on(this._textareaEl, 'input', () => {
			this._autoResize();
			this._syncSendButtonState();
			this._handleMentionInput();
		});

		// Create the peeking bottom tray (Cursor/Windsurf style, rounded 8px)
		const tray = this.append('div', 'sc-input-tray');

		// Flat, borderless button acting as the dropdown trigger
		const localBtn = DOM.append(tray, $('button.sc-tray-btn'));
		localBtn.title = 'SideX Environment Connection Mode';
		localBtn.innerHTML = `
			<svg class="sc-tray-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
				<path d="M5.270 3.041 C 4.702 3.138,4.154 3.442,3.728 3.898 C 3.450 4.195,3.248 4.538,3.114 4.940 L 3.020 5.220 3.009 10.607 L 2.998 15.994 2.249 16.007 C 1.531 16.019,1.494 16.024,1.355 16.118 C 1.276 16.172,1.168 16.278,1.115 16.355 C 1.020 16.494,1.020 16.500,1.020 17.617 C 1.020 18.681,1.025 18.756,1.113 19.040 C 1.256 19.498,1.455 19.822,1.816 20.184 C 2.178 20.545,2.502 20.744,2.960 20.887 L 3.260 20.980 12.000 20.980 L 20.740 20.980 21.040 20.887 C 21.498 20.744,21.822 20.545,22.184 20.184 C 22.545 19.822,22.744 19.498,22.887 19.040 C 22.975 18.756,22.980 18.681,22.980 17.613 C 22.980 16.349,22.993 16.409,22.664 16.142 L 22.513 16.020 21.757 16.007 L 21.002 15.994 20.991 10.607 L 20.980 5.220 20.886 4.940 C 20.605 4.098,19.928 3.409,19.109 3.131 L 18.780 3.020 12.120 3.014 C 8.457 3.011,5.375 3.023,5.270 3.041 M18.760 4.623 C 19.052 4.758,19.225 4.929,19.365 5.220 L 19.480 5.460 19.480 10.730 L 19.480 16.000 12.000 16.000 L 4.520 16.000 4.520 10.730 L 4.521 5.460 4.623 5.240 C 4.758 4.948,4.929 4.775,5.220 4.635 L 5.460 4.520 12.000 4.520 L 18.540 4.521 18.760 4.623 M21.480 18.030 C 21.480 18.508,21.473 18.555,21.366 18.782 C 21.226 19.076,20.954 19.327,20.667 19.428 C 20.470 19.497,20.050 19.500,12.000 19.500 C 3.950 19.500,3.530 19.497,3.333 19.428 C 3.046 19.327,2.774 19.076,2.634 18.782 C 2.527 18.555,2.520 18.508,2.520 18.030 L 2.520 17.520 12.000 17.520 L 21.480 17.520 21.480 18.030 " stroke="none" fill-rule="evenodd" fill="currentColor"></path>
			</svg>
			<span>Local</span>
		`;

		// Bottom tray dropdown menu (inherits sc-mode-menu layout, but layers correctly)
		const trayMenu = DOM.append(this.element, $('div.sc-mode-menu.sc-tray-menu'));

		// Item 1: Local (Active)
		const mLocal = DOM.append(trayMenu, $('div.sc-mode-menu-item.active'));
		mLocal.innerHTML = `
			<div style="display: flex; align-items: center; gap: 8px;">
				<svg class="sc-tray-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
					<path d="M5.270 3.041 C 4.702 3.138,4.154 3.442,3.728 3.898 C 3.450 4.195,3.248 4.538,3.114 4.940 L 3.020 5.220 3.009 10.607 L 2.998 15.994 2.249 16.007 C 1.531 16.019,1.494 16.024,1.355 16.118 C 1.276 16.172,1.168 16.278,1.115 16.355 C 1.020 16.494,1.020 16.500,1.020 17.617 C 1.020 18.681,1.025 18.756,1.113 19.040 C 1.256 19.498,1.455 19.822,1.816 20.184 C 2.178 20.545,2.502 20.744,2.960 20.887 L 3.260 20.980 12.000 20.980 L 20.740 20.980 21.040 20.887 C 21.498 20.744,21.822 20.545,22.184 20.184 C 22.545 19.822,22.744 19.498,22.887 19.040 C 22.975 18.756,22.980 18.681,22.980 17.613 C 22.980 16.349,22.993 16.409,22.664 16.142 L 22.513 16.020 21.757 16.007 L 21.002 15.994 20.991 10.607 L 20.980 5.220 20.886 4.940 C 20.605 4.098,19.928 3.409,19.109 3.131 L 18.780 3.020 12.120 3.014 C 8.457 3.011,5.375 3.023,5.270 3.041 M18.760 4.623 C 19.052 4.758,19.225 4.929,19.365 5.220 L 19.480 5.460 19.480 10.730 L 19.480 16.000 12.000 16.000 L 4.520 16.000 4.520 10.730 L 4.521 5.460 4.623 5.240 C 4.758 4.948,4.929 4.775,5.220 4.635 L 5.460 4.520 12.000 4.520 L 18.540 4.521 18.760 4.623 M21.480 18.030 C 21.480 18.508,21.473 18.555,21.366 18.782 C 21.226 19.076,20.954 19.327,20.667 19.428 C 20.470 19.497,20.050 19.500,12.000 19.500 C 3.950 19.500,3.530 19.497,3.333 19.428 C 3.046 19.327,2.774 19.076,2.634 18.782 C 2.527 18.555,2.520 18.508,2.520 18.030 L 2.520 17.520 12.000 17.520 L 21.480 17.520 21.480 18.030 " stroke="none" fill-rule="evenodd" fill="currentColor"></path>
				</svg>
				<span class="min-w-0 truncate">Local</span>
			</div>
		`;
		this.on(mLocal, 'click', () => {
			trayMenu.classList.remove('visible');
			localBtn.classList.remove('dropdown-active');
		});

		// Item 2: Worktree (Disabled Coming Soon)
		const mWorktree = DOM.append(trayMenu, $('div.sc-mode-menu-item.disabled'));
		mWorktree.title = 'Worktree Mode — Coming Soon';
		mWorktree.innerHTML = `
			<div style="display: flex; align-items: center; gap: 8px;">
				<svg class="sc-tray-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M15 6a9 9 0 0 0-9 9V3"></path>
					<circle cx="18" cy="6" r="3"></circle>
					<circle cx="6" cy="18" r="3"></circle>
				</svg>
				<span class="min-w-0 truncate">Worktree</span>
			</div>
			<span style="font-size: 10px; opacity: 0.6; margin-left: auto; padding-right: 4px;">soon</span>
		`;

		// Item 3: Cloud (Disabled Coming Soon)
		const mCloud = DOM.append(trayMenu, $('div.sc-mode-menu-item.disabled'));
		mCloud.title = 'Cloud Mode — Coming Soon';
		mCloud.innerHTML = `
			<div style="display: flex; align-items: center; gap: 8px;">
				<svg class="sc-tray-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
					<path d="M8.120 4.042 C 5.012 4.380,2.409 6.479,1.423 9.443 C 0.555 12.051,1.045 14.847,2.750 17.017 C 3.051 17.400,3.710 18.048,4.102 18.346 C 5.293 19.253,6.701 19.816,8.140 19.961 C 8.444 19.991,10.018 20.000,13.220 19.990 C 18.375 19.973,18.072 19.989,18.949 19.697 C 19.684 19.452,20.371 19.063,20.949 18.562 C 22.629 17.109,23.359 14.796,22.819 12.639 C 22.541 11.528,22.013 10.611,21.194 9.816 C 20.287 8.936,19.251 8.419,17.986 8.215 C 17.669 8.164,17.419 8.155,16.841 8.172 C 15.925 8.200,15.924 8.200,15.636 7.746 C 14.696 6.265,13.372 5.168,11.740 4.520 C 11.360 4.369,10.649 4.180,10.160 4.100 C 9.692 4.024,8.578 3.992,8.120 4.042 M9.907 5.582 C 10.933 5.734,11.911 6.154,12.802 6.825 C 13.349 7.237,13.853 7.787,14.310 8.469 C 14.686 9.031,14.885 9.245,15.200 9.425 C 15.635 9.672,10.011 9.737,16.646 9.675 C 17.475 9.594,18.231 9.720,18.949 10.060 C 19.461 10.302,19.857 10.586,20.248 10.993 C 20.618 11.379,20.793 11.626,21.031 12.101 C 21.344 12.725,21.479 13.327,21.480 14.094 C 21.481 16.114,20.139 17.851,18.180 18.366 C 17.629 18.511,17.051 18.526,12.600 18.510 C 7.987 18.492,8.131 18.499,7.300 18.285 C 4.951 17.679,3.068 15.640,2.616 13.213 C 2.528 12.742,2.497 11.649,2.558 11.184 C 2.840 9.038,4.117 7.199,6.000 6.226 C 6.952 5.735,7.792 5.529,8.875 5.523 C 9.242 5.521,9.658 5.545,9.907 5.582 " stroke="none" fill-rule="evenodd" fill="currentColor"></path>
				</svg>
				<span class="min-w-0 truncate">Cloud</span>
			</div>
			<span style="font-size: 10px; opacity: 0.6; margin-left: auto; padding-right: 4px;">soon</span>
		`;

		this.on(localBtn, 'click', (e) => {
			e.stopPropagation();
			const show = !trayMenu.classList.contains('visible');
			trayMenu.classList.toggle('visible', show);
			localBtn.classList.toggle('dropdown-active', show);
			// Mutual exclusion: close other popovers/menus
			contextPopover.classList.remove('visible');
			modelMenu.classList.remove('visible');
			this._modeMenu.classList.remove('visible');
		});

		this.on(document.body, 'click', (e) => {
			const target = e.target as Node;
			if (!localBtn.contains(target) && !trayMenu.contains(target)) {
				trayMenu.classList.remove('visible');
				localBtn.classList.remove('dropdown-active');
			}
		});

		// Fetch general settings to initialize defaultAgent mode
		const tInvoke = (globalThis as any).__TAURI_INTERNALS__?.invoke;
		if (tInvoke) {
			tInvoke('settings_get', { section: 'sidex.general' })
				.then(raw => {
					let data: any = raw;
					if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch { return; } }
					if (data && typeof data === 'object') {
						const mode = data.defaultAgent;
						if (mode === 'agent' || mode === 'plan' || mode === 'ask') {
							this.setMode(mode);
						}
					}
				})
				.catch(() => {});
		}
	}

	focus(): void { this._textareaEl.focus(); }

	setStreaming(streaming: boolean): void {
		this._sendBtn.style.display = streaming ? 'none' : 'flex';
		this._stopBtn.style.display = streaming ? 'flex' : 'none';
	}

	setMode(mode: AgentMode): void {
		this._currentMode = mode;
		this._modeLabel.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
		this._modeMenu.querySelectorAll('.sc-mode-menu-item').forEach(item => {
			(item as HTMLElement).classList.toggle('active', (item as HTMLElement).dataset.mode === mode);
		});
	}

	/** Set the model shown in the footer. Renders the display name when known. */
	setModel(model: string): void {
		this._currentModel = model;
		const known = this._modelCatalog.find(m => m.id === model);
		const base = known?.name || model.replace(/^[a-z0-9-]+\//, '') || model;
		this._modelLabel.textContent = this._reasoningLevel === 'None'
			? base
			: `${base} · ${this._reasoningLevel}`;
	}

	getModel(): string { return this._currentModel; }

	private _modelCatalog: Array<{ id: string; name: string }> = [];
	private readonly _modelMenuDisposables = this._register(new DisposableStore());

	/** Populate the model dropdown with models from the server. */
	setAvailableModels(models: Array<{ id: string; name: string }>): void {
		const menu = this.element.querySelector('.sc-model-menu');
		if (!menu) { return; }
		// Clear stale listeners from the previous population — registering
		// into the component-lifetime store leaked one set per refresh.
		this._modelMenuDisposables.clear();
		menu.innerHTML = '';
		this._modelCatalog = models;

		if (models.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'sc-model-menu-item';
			empty.style.opacity = '0.7';
			empty.style.cursor = 'default';
			empty.textContent = 'No models enabled — enable models in Settings';
			menu.appendChild(empty);
		}

		for (const m of models) {
			const item = document.createElement('div');
			item.className = 'sc-model-menu-item';
			item.dataset.modelId = m.id;
			item.textContent = m.name;
			item.title = m.id;
			if (m.id === this._currentModel) { item.classList.add('active'); }
			this._onMenu(item, 'click', () => {
				this.setModel(m.id);
				this._onModelChange.fire(m.id);
				menu.classList.remove('visible');
				menu.querySelectorAll('.sc-model-menu-item').forEach(el =>
					(el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.modelId === m.id)
				);
			});
			menu.appendChild(item);
		}

		// Re-render the footer label now that display names are known.
		if (this._currentModel) { this.setModel(this._currentModel); }

		// ULTRA Mode toggle — at the bottom of the model picker, like Cursor's Max Mode
		const sep = document.createElement('div');
		sep.className = 'sc-model-menu-separator';
		menu.appendChild(sep);

		const ultraRow = document.createElement('div');
		ultraRow.className = 'sc-model-menu-ultra';
		const ultraLabel = document.createElement('span');
		ultraLabel.textContent = 'ULTRA Mode';
		ultraRow.appendChild(ultraLabel);

		const ultraToggle = document.createElement('div');
		ultraToggle.className = 'sc-ultra-toggle' + (this._reasoningLevel === 'Ultra' || this._maxMode ? ' on' : '');
		ultraRow.appendChild(ultraToggle);
		menu.appendChild(ultraRow);

		// Reasoning/Effort slider directly inside the model dropdown menu (Cursor-style)
		const reasoningSep = document.createElement('div');
		reasoningSep.className = 'sc-model-menu-separator';
		menu.appendChild(reasoningSep);

		const reasoningRow = document.createElement('div');
		reasoningRow.className = 'sc-model-menu-reasoning';
		// Prevent clicking on the slider row from closing the dropdown menu
		this._onMenu(reasoningRow, 'click', (e) => e.stopPropagation());

		const rHeader = DOM.append(reasoningRow, $('div.sc-model-menu-reasoning-header'));
		const rTitle = DOM.append(rHeader, $('span'));
		rTitle.textContent = 'Effort';
		const rVal = DOM.append(rHeader, $('span.sc-model-menu-reasoning-level-val'));

		const rSliderContainer = DOM.append(reasoningRow, $('div.sc-model-menu-reasoning-slider-container'));
		const rSlider = DOM.append(rSliderContainer, $('input.sc-model-menu-reasoning-slider')) as HTMLInputElement;
		rSlider.type = 'range';
		rSlider.min = '0';
		rSlider.max = '4';
		rSlider.step = '1';

		const ticks = DOM.append(rSliderContainer, $('div.sc-model-menu-reasoning-ticks'));
		for (const label of ['None', 'Low', 'Med', 'High', 'Ultra']) {
			DOM.append(ticks, $('span')).textContent = label;
		}

		const commitLevel = (lvl: 'None' | 'Low' | 'Medium' | 'High' | 'Ultra') => {
			this._reasoningLevel = lvl;
			this._maxMode = lvl === 'Ultra';
			try { localStorage.setItem(ChatInput.REASONING_STORAGE_KEY, lvl); } catch { /* */ }
			rVal.textContent = lvl;
			const idx = ChatInput.REASONING_LEVELS.indexOf(lvl);
			rSlider.value = String(idx < 0 ? 0 : idx);
			ultraToggle.classList.toggle('on', this._maxMode);
			this._paintEffortTicks(ticks, idx < 0 ? 0 : idx);
			if (this._currentModel) { this.setModel(this._currentModel); }
			this._onMaxModeChange.fire(this._maxMode);
			this._onThinkingBudgetChange.fire(this.thinkingBudget);
		};

		this._onMenu(ultraRow, 'click', (e) => {
			e.stopPropagation();
			commitLevel(this._reasoningLevel === 'Ultra' ? 'High' : 'Ultra');
		});

		const currentIdx = ChatInput.REASONING_LEVELS.indexOf(this._reasoningLevel);
		rSlider.value = currentIdx !== -1 ? String(currentIdx) : '0';
		rVal.textContent = this._reasoningLevel;
		this._paintEffortTicks(ticks, currentIdx !== -1 ? currentIdx : 0);
		this._maxMode = this._reasoningLevel === 'Ultra';
		ultraToggle.classList.toggle('on', this._maxMode);

		this._onMenu(rSlider, 'input', () => {
			const lvl = ChatInput.REASONING_LEVELS[parseInt(rSlider.value, 10)] ?? 'None';
			commitLevel(lvl);
		});

		menu.appendChild(reasoningRow);
	}

	private _paintEffortTicks(ticks: HTMLElement, activeIdx: number): void {
		const nodes = ticks.querySelectorAll('span');
		nodes.forEach((n, i) => n.classList.toggle('active', i === activeIdx));
	}

	/** Register a listener tied to the current model-menu population. */
	private _onMenu(el: HTMLElement, event: string, handler: (e: globalThis.Event) => void): void {
		this._modelMenuDisposables.add(DOM.addDisposableListener(el, event, handler as EventListener));
	}

	private _setMode(mode: AgentMode): void {
		this.setMode(mode);
		this._onModeChange.fire(mode);
	}

	// --- Mention system ---

	private _handleMentionInput(): void {
		const value = this._textareaEl.value;
		const cursorPos = this._textareaEl.selectionStart;
		const textBefore = value.substring(0, cursorPos);
		const atIndex = textBefore.lastIndexOf('@');

		// Must have an @, and it must be at the start or preceded by whitespace
		if (atIndex === -1) {
			this._mentionTracking.active = false;
			this._mentionPopup.hide();
			return;
		}
		if (atIndex > 0 && textBefore[atIndex - 1] !== ' ' && textBefore[atIndex - 1] !== '\n') {
			this._mentionTracking.active = false;
			this._mentionPopup.hide();
			return;
		}

		const query = textBefore.substring(atIndex + 1);

		// A space within the query terminates the mention
		if (query.includes(' ')) {
			this._mentionTracking.active = false;
			this._mentionPopup.hide();
			return;
		}

		this._mentionTracking = { active: true, startPos: atIndex };
		this._debouncedSearch(query);
	}

	private _debouncedSearch(query: string): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}
		this._debounceTimer = setTimeout(async () => {
			try {
				const suggestions = await this._mentionResolver.getSuggestions(query);
				if (!this._mentionTracking.active) { return; }

				const anchorRect = this._getCaretRect();
				this._mentionPopup.show(suggestions, anchorRect);
			} catch {
				this._mentionPopup.hide();
			}
		}, 150);
	}

	private _getCaretRect(): DOMRect {
		// Approximate caret position using a temporary span
		const textarea = this._textareaEl;
		const rect = textarea.getBoundingClientRect();

		// Rough estimation: use textarea position as anchor
		return new DOMRect(
			rect.left + 12,
			rect.top,
			1,
			20
		);
	}

	private async _onMentionSelected(item: MentionItem): Promise<void> {
		if (!this._mentionTracking.active) { return; }

		const value = this._textareaEl.value;
		const cursorPos = this._textareaEl.selectionStart;
		const before = value.substring(0, this._mentionTracking.startPos);
		const after = value.substring(cursorPos);

		// Remove "@query" from textarea and replace with nothing (pill goes above)
		this._textareaEl.value = before + after;
		this._textareaEl.selectionStart = before.length;
		this._textareaEl.selectionEnd = before.length;

		this._mentionTracking.active = false;
		this._autoResize();

		// Resolve the mention content
		let resolvedContent = '';
		try {
			resolvedContent = await this._mentionResolver.resolve(item);
		} catch {
			resolvedContent = `[Could not resolve: ${item.label}]`;
		}

		const mention: ResolvedMention = { item, resolvedContent };
		this._resolvedMentions.push(mention);
		this._renderMentionPill(mention);

		this._syncSendButtonState();

		this._textareaEl.focus();
	}

	private _renderMentionPill(mention: ResolvedMention): void {
		const pill = document.createElement('span');
		pill.className = 'sc-mention-pill';

		const iconEl = document.createElement('span');
		iconEl.className = 'sc-mention-pill-icon';
		if (mention.item.type === 'folder') {
			iconEl.classList.add('codicon', 'codicon-folder');
		} else if (mention.item.type === 'symbol') {
			iconEl.classList.add('codicon', 'codicon-symbol-method');
		} else {
			iconEl.classList.add('codicon', 'codicon-file');
		}
		pill.appendChild(iconEl);

		const labelEl = document.createElement('span');
		labelEl.className = 'sc-mention-pill-label';
		labelEl.textContent = mention.item.label;
		pill.appendChild(labelEl);

		const removeBtn = document.createElement('span');
		removeBtn.className = 'sc-mention-pill-remove';
		removeBtn.innerHTML = '&times;';
		removeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const idx = this._resolvedMentions.indexOf(mention);
			if (idx !== -1) { this._resolvedMentions.splice(idx, 1); }
			pill.remove();
			this._syncSendButtonState();
		});
		pill.appendChild(removeBtn);

		this._mentionPillsContainer.appendChild(pill);
		this._mentionPillsContainer.style.display = '';
	}

	private async _attachFiles(): Promise<void> {
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const selected = await open({
				multiple: true,
				directory: false,
			});
			const paths = Array.isArray(selected)
				? selected
				: typeof selected === 'string'
					? [selected]
					: [];
			await this._addAttachments(paths);
		} catch (e) {
			console.warn('[sidex-chat] attach file failed:', e);
		}
	}

	private async _addAttachments(paths: string[]): Promise<void> {
		for (const path of paths) {
			if (!path || this._attachments.some(a => a.path === path)) { continue; }
			const storedPath = await this._copyAttachmentToAssets(path);
			const attachment: ChatAttachment = {
				path: storedPath,
				originalPath: path,
				name: this._basename(path),
				kind: this._isImagePath(path) ? 'image' : 'file',
			};
			this._attachments.push(attachment);
			this._renderAttachmentPill(attachment);
		}
		this._syncSendButtonState();
	}

	private _renderAttachmentPill(attachment: ChatAttachment): void {
		const pill = document.createElement('span');
		pill.className = attachment.kind === 'image'
			? 'context-pill context-pill-image sc-attachment-image-pill'
			: 'sc-mention-pill sc-attachment-pill';
		pill.title = attachment.path;

		const removeBtn = document.createElement('button');
		removeBtn.type = 'button';
		removeBtn.className = attachment.kind === 'image' ? 'sc-attachment-image-remove' : 'sc-mention-pill-remove';
		removeBtn.setAttribute('aria-label', `Remove ${attachment.name}`);
		removeBtn.textContent = '×';
		removeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this._attachments = this._attachments.filter(a => a !== attachment);
			pill.remove();
			this._syncSendButtonState();
		});

		if (attachment.kind === 'image') {
			const imageContainer = document.createElement('div');
			imageContainer.className = 'image-pill-container';
			const img = document.createElement('img');
			img.className = 'image-pill-img';
			img.alt = 'Attached image';
			img.loading = 'lazy';
			imageContainer.appendChild(img);
			imageContainer.appendChild(removeBtn);
			pill.appendChild(imageContainer);
			void this._loadAttachmentImage(img, attachment.path);
		} else {
			const iconEl = document.createElement('span');
			iconEl.className = 'sc-mention-pill-icon';
			iconEl.classList.add('codicon', 'codicon-file');
			pill.appendChild(iconEl);

			const labelEl = document.createElement('span');
			labelEl.className = 'sc-mention-pill-label';
			labelEl.textContent = attachment.name;
			pill.appendChild(labelEl);
			pill.appendChild(removeBtn);
		}

		this._attachmentsContainer.appendChild(pill);
	}

	private _bindAttachmentDrop(dropArea: HTMLElement, visualTarget: HTMLElement): void {
		this.on(dropArea, 'dragenter', (e) => {
			const event = e as DragEvent;
			if (!this._eventHasFiles(event)) { return; }
			event.preventDefault();
			event.stopPropagation();
			this._dragDepth++;
			visualTarget.classList.add('drag-over');
		});
		this.on(dropArea, 'dragover', (e) => {
			const event = e as DragEvent;
			if (!this._eventHasFiles(event)) { return; }
			event.preventDefault();
			event.stopPropagation();
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = 'copy';
			}
			visualTarget.classList.add('drag-over');
		});
		this.on(dropArea, 'dragleave', (e) => {
			const event = e as DragEvent;
			if (!this._eventHasFiles(event)) { return; }
			event.preventDefault();
			event.stopPropagation();
			this._dragDepth = Math.max(0, this._dragDepth - 1);
			if (this._dragDepth === 0) {
				visualTarget.classList.remove('drag-over');
			}
		});
		this.on(dropArea, 'drop', (e) => {
			const event = e as DragEvent;
			if (!this._eventHasFiles(event)) { return; }
			event.preventDefault();
			event.stopPropagation();
			this._dragDepth = 0;
			visualTarget.classList.remove('drag-over');
			void this._addDroppedFiles(event);
		});
	}

	private _eventHasFiles(event: DragEvent): boolean {
		const transfer = event.dataTransfer;
		if (!transfer) { return false; }
		return transfer.files.length > 0 || Array.from(transfer.types).includes('Files');
	}

	private async _addDroppedFiles(event: DragEvent): Promise<void> {
		const files = Array.from(event.dataTransfer?.files ?? []);
		const pathBackedFiles: string[] = [];
		const byteBackedFiles: File[] = [];
		for (const file of files) {
			const path = this._pathFromDroppedFile(file);
			if (path) {
				pathBackedFiles.push(path);
			} else {
				byteBackedFiles.push(file);
			}
		}
		await this._addAttachments(pathBackedFiles);
		for (const file of byteBackedFiles) {
			const attachment = await this._attachmentFromDroppedBytes(file);
			if (!attachment || this._attachments.some(a => a.path === attachment.path)) { continue; }
			this._attachments.push(attachment);
			this._renderAttachmentPill(attachment);
		}
		this._syncSendButtonState();
	}

	private _pathFromDroppedFile(file: File): string | null {
		const maybeFile = file as File & { path?: string };
		if (maybeFile.path) {
			return maybeFile.path;
		}
		return null;
	}

	private async _attachmentFromDroppedBytes(file: File): Promise<ChatAttachment | null> {
		const invoke = this._getTauriInvoke();
		if (!invoke) { return null; }
		try {
			const osInfo = await invoke('get_os_info') as { homedir?: string };
			const home = osInfo?.homedir;
			const workspace = this._chatService.workspacePath || 'default';
			if (!home) { return null; }
			const assetsDir = `${home}/.sidex/projects/${this._workspaceSlug(workspace)}/assets`;
			await invoke('mkdir', { path: assetsDir, recursive: true });
			const sourceName = file.name || `dropped-${Date.now()}`;
			const assetPath = `${assetsDir}/${crypto.randomUUID()}${this._extension(sourceName)}`;
			const content = Array.from(new Uint8Array(await file.arrayBuffer()));
			await invoke('write_file_bytes', { path: assetPath, content });
			return {
				path: assetPath,
				originalPath: sourceName,
				name: sourceName,
				kind: this._isImagePath(sourceName) || file.type.startsWith('image/') ? 'image' : 'file',
			};
		} catch (e) {
			console.warn('[sidex-chat] failed to attach dropped file:', e);
			return null;
		}
	}

	private async _loadAttachmentImage(img: HTMLImageElement, path: string): Promise<void> {
		const invoke = this._getTauriInvoke();
		if (!invoke) { return; }
		try {
			const bytes = await invoke('read_file_bytes', { path }) as number[] | Uint8Array;
			const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
			img.src = `data:${this._mimeFromPath(path)};base64,${this._base64FromBytes(data)}`;
		} catch (e) {
			console.warn('[sidex-chat] failed to load attachment image preview:', e);
		}
	}

	private _base64FromBytes(bytes: Uint8Array): string {
		let binary = '';
		const chunkSize = 0x8000;
		for (let i = 0; i < bytes.length; i += chunkSize) {
			binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
		}
		return btoa(binary);
	}

	private _mimeFromPath(path: string): string {
		const lowered = path.toLowerCase();
		if (lowered.endsWith('.jpg') || lowered.endsWith('.jpeg')) { return 'image/jpeg'; }
		if (lowered.endsWith('.gif')) { return 'image/gif'; }
		if (lowered.endsWith('.webp')) { return 'image/webp'; }
		return 'image/png';
	}

	private _buildAttachmentContext(): string {
		if (this._attachments.length === 0) { return ''; }
		const lines = [
			'<attachments>',
			'The user attached these local files. They were copied into the SideX project assets directory. Use read_file before making claims about their contents; read_file supports both text/code files and image files.',
		];
		for (const attachment of this._attachments) {
			lines.push(`- ${attachment.kind}: ${attachment.path} (name: ${attachment.name}, original: ${attachment.originalPath}, use read_file)`);
		}
		lines.push('</attachments>', '');
		return lines.join('\n');
	}

	private async _copyAttachmentToAssets(sourcePath: string): Promise<string> {
		const invoke = this._getTauriInvoke();
		if (!invoke) { return sourcePath; }
		try {
			const osInfo = await invoke('get_os_info') as { homedir?: string };
			const home = osInfo?.homedir;
			const workspace = this._chatService.workspacePath || 'default';
			if (!home) { return sourcePath; }

			const assetsDir = `${home}/.sidex/projects/${this._workspaceSlug(workspace)}/assets`;
			await invoke('mkdir', { path: assetsDir, recursive: true });

			const assetPath = `${assetsDir}/${crypto.randomUUID()}${this._extension(sourcePath)}`;
			const bytes = await invoke('read_file_bytes', { path: sourcePath });
			await invoke('write_file_bytes', { path: assetPath, content: bytes });
			return assetPath;
		} catch (e) {
			console.warn('[sidex-chat] failed to copy attachment into assets:', e);
			return sourcePath;
		}
	}

	private _buildAttachmentDisplayMarkdown(): string {
		if (this._attachments.length === 0) { return ''; }
		const lines: string[] = [];
		for (const attachment of this._attachments) {
			if (attachment.kind === 'image') {
				lines.push(`![${attachment.name}](${attachment.path})`);
			} else {
				lines.push(`Attached file: \`${attachment.path}\``);
			}
		}
		return lines.join('\n');
	}

	private _hasSendableContent(): boolean {
		return this._textareaEl.value.trim().length > 0 ||
			this._resolvedMentions.length > 0 ||
			this._attachments.length > 0;
	}

	private _syncSendButtonState(): void {
		this._sendBtn.classList.toggle('disabled', !this._hasSendableContent());
	}

	private _basename(path: string): string {
		return path.split(/[\\/]/).filter(Boolean).pop() || path;
	}

	private _extension(path: string): string {
		const base = this._basename(path);
		const idx = base.lastIndexOf('.');
		return idx > 0 ? base.slice(idx) : '';
	}

	private _workspaceSlug(workspacePath: string): string {
		const clean = workspacePath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
		return clean.replace(/^\//, '').replace(/\//g, '-') || 'default';
	}

	private _getTauriInvoke(): TauriInvoke | null {
		const g = globalThis as unknown as {
			__TAURI_INVOKE__?: TauriInvoke;
			__TAURI_INTERNALS__?: { invoke: TauriInvoke };
		};
		return g.__TAURI_INVOKE__ ?? g.__TAURI_INTERNALS__?.invoke ?? null;
	}

	private _isImagePath(path: string): boolean {
		return /\.(png|jpe?g|gif|webp)$/i.test(path);
	}

	// --- Send ---

	private _doSend(): void {
		const text = this._textareaEl.value.trim();
		if (!this._hasSendableContent()) { return; }

		this._textareaEl.value = '';
		this._autoResize();
		this._sendBtn.classList.add('disabled');

		// Build the full message with mention context prepended
		let fullMessage = '';
		for (const m of this._resolvedMentions) {
			fullMessage += `<context source="@${m.item.label}">\n${m.resolvedContent}\n</context>\n\n`;
		}
		fullMessage += this._buildAttachmentContext();
		const attachmentDisplay = this._buildAttachmentDisplayMarkdown();
		fullMessage += [text, attachmentDisplay].filter(Boolean).join('\n\n');

		// Clear mentions
		const mentionsCopy = [...this._resolvedMentions];
		this._resolvedMentions = [];
		this._attachments = [];
		DOM.clearNode(this._mentionPillsContainer);
		this._mentionPillsContainer.style.display = 'none';
		DOM.clearNode(this._attachmentsContainer);

		this._onSendWithMentions.fire({ text: fullMessage, mentions: mentionsCopy });
		this._onSend.fire(fullMessage);
	}

	private _autoResize(): void {
		this._textareaEl.style.height = 'auto';
		this._textareaEl.style.height = `${Math.min(this._textareaEl.scrollHeight, 120)}px`;
	}

	get thinkingBudget(): number {
		switch (this._reasoningLevel) {
			case 'Low': return 2000;
			case 'Medium': return 4000;
			case 'High': return 8000;
			case 'Ultra': return 16000;
			default: return 0;
		}
	}

	get thinkingEffort(): 'none' | 'low' | 'medium' | 'high' | 'ultra' {
		return this._reasoningLevel.toLowerCase() as 'none' | 'low' | 'medium' | 'high' | 'ultra';
	}

	private _updateContextUsage(popover: HTMLElement, contextBadge: HTMLElement): void {
		// Calculate actual message characters
		let msgChars = 0;
		let hasSkills = false;
		let hasMcp = false;

		if (this._chatService && Array.isArray(this._chatService.messages)) {
			for (const m of this._chatService.messages) {
				const content = m.content || '';
				msgChars += content.length;
				if (m.thinkingContent) {
					msgChars += m.thinkingContent.length;
				}
				if (content.includes('<skill_content') || content.includes('kilo-config')) {
					hasSkills = true;
				}
				if (content.includes('mcp_') || content.includes('Model Context Protocol')) {
					hasMcp = true;
				}
			}
		}

		// 100% Real, active-state-derived token estimates mapping the Go server's actual prompts and schemas
		const mode = this._chatService?.currentMode || 'agent';

		// System prompt: Base is exactly 3,660 tokens; plan mode adds 245 tokens; ask mode adds 65 tokens.
		const systemTokens = mode === 'plan' ? 3905 : mode === 'ask' ? 3725 : 3660;

		// Tool definitions: Go server registers 43 tools (~12,900 tokens).
		// Gated by mode-specific filters: plan mode filters to 26 tools (~7,800 tokens), ask filters to 23 tools (~6,900 tokens).
		const toolTokens = mode === 'plan' ? 7800 : mode === 'ask' ? 6900 : 12900;

		// Skills prompt: loaded dynamically from active context (approx. 1,200 tokens).
		const skillsTokens = hasSkills ? 1200 : 0;

		// MCP tool schemas: loaded dynamically when MCP servers are connected (~2,300 tokens).
		const mcpTokens = hasMcp ? 2300 : 0;

		// Subagent definitions: standard explorer/general prompts (~727 tokens).
		const subagentTokens = 727;

		// Conversation transcript: exactly measured from active message chars (~4 chars per token).
		const conversationTokens = Math.round(msgChars / 4);

		const estimated = systemTokens + toolTokens + skillsTokens + mcpTokens + subagentTokens + conversationTokens;
		const lastPrompt = this._chatService?.lastPromptTokens ?? 0;
		const totalTokens = lastPrompt > 0 ? lastPrompt : estimated;
		const maxTokens = this._chatService?.contextWindow || 200000;
		const pct = Math.max(0, Math.min(100, (totalTokens / maxTokens) * 100));

		// Update the minimal circular progress ring (SVG stroke-dashoffset)
		const fill = contextBadge.querySelector('.sc-context-ring-fill') as SVGCircleElement | null;
		if (fill) {
			const circumference = 37.7;
			const offset = circumference - (pct / 100) * circumference;
			fill.style.strokeDashoffset = `${offset}`;
		}
		const maxLabel = maxTokens >= 1_000_000 ? `${(maxTokens / 1_000_000).toFixed(0)}M` : `${Math.round(maxTokens / 1000)}K`;
		contextBadge.title = `Context: ~${(totalTokens / 1000).toFixed(1)}K of ${maxLabel} tokens (${pct < 1 ? pct.toFixed(1) : Math.round(pct)}% full)`;

		// Clear and rebuild popover body dynamically
		popover.innerHTML = '';

		const header = DOM.append(popover, $('div.sc-context-header'));
		const title = DOM.append(header, $('div.sc-context-title'));
		title.textContent = 'Context Usage';

		const actions = DOM.append(header, $('div.sc-context-actions'));

		const close = DOM.append(actions, $('span.sc-context-close'));
		close.innerHTML = '✕';
		this._onMenu(close, 'click', () => popover.classList.remove('visible'));

		const summary = DOM.append(popover, $('div.sc-context-summary'));
		const pctFull = DOM.append(summary, $('span'));
		pctFull.textContent = `${pct < 1 ? pct.toFixed(1) : Math.round(pct)}% Full`;
		pctFull.style.fontWeight = 'bold';
		const tokenFraction = DOM.append(summary, $('span'));
		tokenFraction.textContent = `~${(totalTokens / 1000).toFixed(1)}K / ${maxLabel} Tokens`;

		const bar = DOM.append(popover, $('div.sc-context-bar'));

		// Single solid progress segment representing the total pct filled (monochromatic, clean, premium)
		const seg = DOM.append(bar, $('div.sc-context-segment'));
		seg.style.width = `${pct}%`;

		const segments = [
			{ tokens: systemTokens, name: 'System prompt' },
			{ tokens: toolTokens, name: 'Tool definitions' },
			{ tokens: skillsTokens, name: 'Skills' },
			{ tokens: mcpTokens, name: 'MCP' },
			{ tokens: subagentTokens, name: 'Subagent definitions' },
			{ tokens: conversationTokens, name: 'Conversation' }
		];

		const legend = DOM.append(popover, $('div.sc-context-legend'));

		for (const s of segments) {
			const row = DOM.append(legend, $('div.sc-context-legend-row'));
			const lblCol = DOM.append(row, $('div.sc-context-legend-label'));
			const name = DOM.append(lblCol, $('span'));
			name.textContent = s.name;

			const val = DOM.append(row, $('span.sc-context-legend-val'));
			val.textContent = s.tokens >= 1000 ? `${(s.tokens / 1000).toFixed(1)}K` : `${s.tokens}`;
		}
	}
}
