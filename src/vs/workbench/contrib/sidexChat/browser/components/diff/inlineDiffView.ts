/*---------------------------------------------------------------------------------------------
 *  InlineDiffView — Cursor-style compact diff display with Accept/Reject.
 *  Shows filename + change counts, colored diff lines, and text action buttons.
 *--------------------------------------------------------------------------------------------*/

import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { computeDiff, groupIntoHunks, DiffHunk } from './diffAlgorithm.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { tokenizeToString } from '../../../../../../editor/common/languages/textToHtmlTokenizer.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { getIconClasses } from '../../../../../../editor/common/services/getIconClasses.js';
import { FileKind } from '../../../../../../platform/files/common/files.js';

export interface DiffCallbacks {
	onAccept: (hunk: DiffHunk) => void;
	onReject: (hunk: DiffHunk) => void;
	onAcceptAll: () => void;
	onRejectAll: () => void;
}

export class InlineDiffView extends Component {
	private readonly _hunks: DiffHunk[];
	private readonly _callbacks: DiffCallbacks;
	private readonly _filePath: string;
	private readonly _addedCount: number;
	private readonly _removedCount: number;
	private readonly _hunkElements = new Map<number, HTMLElement>();

	private readonly _oldLineElements = new Map<number, HTMLElement>();
	private readonly _newLineElements = new Map<number, HTMLElement>();

	private readonly _onDidAcceptHunk = this._register(new Emitter<DiffHunk>());
	readonly onDidAcceptHunk: Event<DiffHunk> = this._onDidAcceptHunk.event;
	private readonly _onDidRejectHunk = this._register(new Emitter<DiffHunk>());
	readonly onDidRejectHunk: Event<DiffHunk> = this._onDidRejectHunk.event;

	constructor(
		filePath: string,
		oldContent: string,
		newContent: string,
		callbacks: DiffCallbacks,
		private readonly _languageService?: ILanguageService,
		private readonly _modelService?: IModelService,
	) {
		super('div', 'ui-tool-call-card');
		this.element.classList.add('ui-edit-tool-call');
		this.element.classList.add('sc-diff-view');
		
		this.element.dataset.hasContent = 'true';
		this.element.classList.add('show-file-icons');
		this._filePath = filePath;
		this._callbacks = callbacks;

		const diffLines = computeDiff(oldContent, newContent);
		this._hunks = groupIntoHunks(diffLines, 4);

		this._addedCount = diffLines.filter(l => l.type === 'added').length;
		this._removedCount = diffLines.filter(l => l.type === 'removed').length;

		this._render();
		this._tokenizeFullContent(oldContent, newContent);
	}

	get hunks(): readonly DiffHunk[] { return this._hunks; }

	private _render(): void {
		this._renderHeader();
		this._renderDiffBody();
	}

	private _renderHeader(): void {
		const header = this.append('div', 'ui-tool-call-card__header');
		header.title = this._filePath;

		const fileInfo = header;

		const segments = this._filePath.split('/');
		const fileName = segments.pop() || this._filePath;
		const resource = URI.file(this._filePath);
		const iconClasses = this._modelService && this._languageService
			? getIconClasses(this._modelService, this._languageService, resource, FileKind.FILE)
			: ['file-icon'];
		const iconEl = DOM.append(fileInfo, DOM.$('span'));
		iconEl.classList.add(...iconClasses);
		iconEl.setAttribute('aria-hidden', 'true');
		iconEl.setAttribute('role', 'img');
		iconEl.setAttribute('data-size', 'sm');

		// Filename
		const pathEl = DOM.append(fileInfo, $('span.ui-edit-tool-call__filename'));
		
		pathEl.textContent = fileName;

		// Change counts
		const countsEl = DOM.append(fileInfo, DOM.$('span.ui-edit-tool-call__stats'));
		if (this._addedCount > 0) {
			const addEl = DOM.append(countsEl, DOM.$('span.ui-edit-tool-call__additions'));
			addEl.textContent = `+${this._addedCount}`;
		}
		if (this._removedCount > 0) {
			const remEl = DOM.append(countsEl, DOM.$('span.ui-edit-tool-call__deletions'));
			remEl.textContent = `-${this._removedCount}`;
		}

		// Action buttons: text labels
		const actions = DOM.append(header, $('div.ui-shell-tool-call__header-actions-anchor'));
		DOM.append(actions, $('span.ui-shell-tool-call__header-actions-spacer'));
		const actionsDiv = DOM.append(actions, $('div.ui-shell-tool-call__header-actions'));

		const rejectBtn = DOM.append(actionsDiv, $<HTMLButtonElement>('button.sc-diff-btn.sc-diff-btn-reject-all'));
		rejectBtn.type = 'button';
		rejectBtn.textContent = 'Reject';
		this.on(rejectBtn, 'click', () => this._rejectAll());

		const acceptBtn = DOM.append(actionsDiv, $<HTMLButtonElement>('button.sc-diff-btn.sc-diff-btn-accept-all'));
		acceptBtn.type = 'button';
		acceptBtn.textContent = 'Accept';
		this.on(acceptBtn, 'click', () => this._acceptAll());
	}

	private _renderDiffBody(): void {
		const body = this.append('div', 'ui-tool-call-card__body');

		const scrollArea = DOM.append(body, DOM.$('div.ui-scroll-area.ui-edit-tool-call__scroll-area.ui-edit-tool-call__expanded-scroll-area'));
		scrollArea.setAttribute('data-scroll-padding', '4');
		scrollArea.setAttribute('data-visibility', 'hover');
		scrollArea.setAttribute('data-direction', 'both');
		
		const viewport = DOM.append(scrollArea, DOM.$('div.ui-scroll-area__viewport'));
		const scrollContent = DOM.append(viewport, DOM.$('div.ui-scroll-area__content'));

		for (const hunk of this._hunks) {
			const hunkEl = DOM.append(scrollContent, DOM.$('div.ui-default-diff.ui-edit-tool-call__preview'));
			hunkEl.setAttribute('data-hide-scrollbar', '');
			hunkEl.setAttribute('data-block-padding', 'compact');
			hunkEl.dataset.hunkId = String(hunk.id);
			this._hunkElements.set(hunk.id, hunkEl);

			const codeEl = DOM.append(hunkEl, DOM.$('div.ui-default-diff__content'));
			const virtualGroup = DOM.append(codeEl, DOM.$('div.ui-default-diff__virtual-group-wrapper'));

			for (let idx = 0; idx < hunk.lines.length; idx++) {
				const line = hunk.lines[idx];
				const lineEl = DOM.append(virtualGroup, DOM.$('div.ui-default-diff__line'));
				lineEl.setAttribute('data-type', line.type === 'context' ? 'unchanged' : line.type);
				lineEl.classList.add(line.type);
				DOM.append(lineEl, DOM.$('div.ui-default-diff__indicator-strip'));
				const cont = DOM.append(lineEl, DOM.$('div.ui-default-diff__line-content'));
				cont.textContent = line.content;

				// Store element reference for async tokenization update
				if (line.type === 'removed' && line.oldLineNo !== undefined) {
					this._oldLineElements.set(line.oldLineNo, cont);
				} else if (line.newLineNo !== undefined) {
					this._newLineElements.set(line.newLineNo, cont);
				}

				
			}

			// Expand/Collapse logic
			const hasHidden = hunk.lines.length > 6;
			if (hasHidden) {
				const expandBtn = DOM.append(body, DOM.$('button.ui-tool-call-card__expand-button.ui-tool-call-card__expand-button--collapsed'));
				expandBtn.setAttribute('type', 'button');
				expandBtn.setAttribute('aria-label', 'Expand diff');
				expandBtn.setAttribute('aria-expanded', 'false');
				const expandIcon = DOM.append(expandBtn, DOM.$('span.ui-tool-call-card__expand-icon'));
				const iconI = DOM.append(expandIcon, DOM.$('span.codicon.codicon-chevron-down'));
				iconI.setAttribute('aria-hidden', 'true');

				let expanded = false;
				this.on(expandBtn, 'click', () => {
					expanded = !expanded;
					expandBtn.classList.toggle('ui-tool-call-card__expand-button--collapsed', !expanded);
					expandBtn.classList.toggle('ui-tool-call-card__expand-button--expanded', expanded);
					expandBtn.setAttribute('aria-expanded', String(expanded));
					expandBtn.setAttribute('aria-label', expanded ? 'Collapse diff' : 'Expand diff');
					iconI.classList.toggle('codicon-chevron-down', !expanded);
					iconI.classList.toggle('codicon-chevron-up', expanded);
					
					scrollArea.classList.toggle('ui-edit-tool-call__expanded-scroll-area', expanded);
					scrollArea.classList.toggle('ui-edit-tool-call__collapsed-scroll-area', !expanded);
				});

				scrollArea.classList.remove('ui-edit-tool-call__expanded-scroll-area');
				scrollArea.classList.add('ui-edit-tool-call__collapsed-scroll-area');
			}
		}
	}

	private _tokenizeFullContent(oldContent: string, newContent: string): void {
		if (!this._languageService) {
			return;
		}

		const langId = this._languageService.guessLanguageIdByFilepathOrFirstLine(
			URI.file(this._filePath)
		) ?? 'plaintext';

		// Tokenize full new content as a single block to preserve parser state
		tokenizeToString(this._languageService, newContent, langId).then(html => {
			const perLineHtml = this._splitTokenizedHtml(html);
			for (const [lineNo, el] of this._newLineElements) {
				const lineHtml = perLineHtml[lineNo - 1];
				if (lineHtml !== undefined) {
					el.innerHTML = lineHtml;
				}
			}
		});

		// Tokenize full old content for removed lines
		if (this._oldLineElements.size > 0) {
			tokenizeToString(this._languageService, oldContent, langId).then(html => {
				const perLineHtml = this._splitTokenizedHtml(html);
				for (const [lineNo, el] of this._oldLineElements) {
					const lineHtml = perLineHtml[lineNo - 1];
					if (lineHtml !== undefined) {
						el.innerHTML = lineHtml;
					}
				}
			});
		}
	}

	private _splitTokenizedHtml(html: string): string[] {
		// tokenizeToString returns: <div class="monaco-tokenized-source">...spans...<br/>...spans...<br/>...</div>
		// Strip the outer div wrapper and split by <br/> to get per-line HTML
		const innerMatch = html.match(/^<div[^>]*>([\s\S]*)<\/div>$/);
		const inner = innerMatch ? innerMatch[1] : html;
		return inner.split('<br/>');
	}

	private _acceptAll(): void {
		for (const hunk of this._hunks) {
			if (hunk.status === 'pending') {
				hunk.status = 'accepted';
				this._updateHunkVisual(hunk);
			}
		}
		this._callbacks.onAcceptAll();
		this.element.classList.add('resolved', 'all-accepted');
	}

	private _rejectAll(): void {
		for (const hunk of this._hunks) {
			if (hunk.status === 'pending') {
				hunk.status = 'rejected';
				this._updateHunkVisual(hunk);
			}
		}
		this._callbacks.onRejectAll();
		this.element.classList.add('resolved', 'all-rejected');
	}

	private _updateHunkVisual(hunk: DiffHunk): void {
		const el = this._hunkElements.get(hunk.id);
		if (!el) { return; }

		el.classList.remove('pending', 'accepted', 'rejected');
		el.classList.add(hunk.status);
	}
}

