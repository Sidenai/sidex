/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { WebviewInitInfo } from '../../webview/browser/webview.js';
import { asWebviewUri } from '../../webview/common/webview.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { DEFAULT_MARKDOWN_STYLES } from './markdownDocumentRenderer.js';
import * as marked from '../../../../base/common/marked/marked.js';
import { ScrollType } from '../../../../editor/common/editorCommon.js';

const MARKDOWN_PREVIEW_VIEW_TYPE = 'sidex.markdown.preview';
const PREVIEW_OPEN_FILES_KEY = 'markdown.preview.openFiles';

const HAS_SCHEME = /^\w[\w\d+.-]*:/;

type SyncSource = 'editor' | 'preview' | null;

function resolveMarkdownUri(baseDir: URI, href: string): URI {
	if (HAS_SCHEME.test(href)) {
		return URI.parse(href);
	}
	return URI.joinPath(baseDir, href);
}

function rewriteImageSrcs(html: string, baseDir: URI): string {
	return html.replace(
		/<img\s+([^>]*?)src="([^"]*?)"([^>]*)>/gi,
		(_match, before: string, src: string, after: string) => {
			if (HAS_SCHEME.test(src) || src.startsWith('data:')) {
				return _match;
			}
			const resolved = resolveMarkdownUri(baseDir, src);
			const webviewSafe = asWebviewUri(resolved);
			return `<img ${before}src="${webviewSafe.toString()}"${after}>`;
		}
	);
}

class LineMappingRenderer extends marked.Renderer {
	private _currentLine = 1;

	reset(startLine: number = 1): void {
		this._currentLine = startLine;
	}

	private _advanceLine(raw: string): number {
		const line = this._currentLine;
		const newlines = raw.split('\n').length - 1;
		this._currentLine += newlines || 1;
		return line;
	}

	heading(token: marked.Tokens.Heading): string {
		const line = this._advanceLine(token.raw);
		const inline = this.parser.parseInline(token.tokens);
		return `<h${token.depth} data-line="${line}">${inline}</h${token.depth}>\n`;
	}

	paragraph(token: marked.Tokens.Paragraph): string {
		const line = this._advanceLine(token.raw);
		const inline = this.parser.parseInline(token.tokens);
		return `<p data-line="${line}">${inline}</p>\n`;
	}

	blockquote(token: marked.Tokens.Blockquote): string {
		const line = this._advanceLine(token.raw);
		const body = this.parser.parse(token.tokens);
		return `<blockquote data-line="${line}">${body}</blockquote>\n`;
	}

	list(token: marked.Tokens.List): string {
		const line = this._advanceLine(token.raw);
		const ordered = token.ordered;
		const start = token.start;
		let body = '';
		for (let j = 0; j < token.items.length; j++) {
			const item = token.items[j];
			body += this.listitem(item);
		}
		const type = ordered ? 'ol' : 'ul';
		const startAttr = ordered && start !== 1 ? ' start="' + start + '"' : '';
		return `<${type} data-line="${line}"${startAttr}>\n${body}</${type}>\n`;
	}

	listitem(item: marked.Tokens.ListItem): string {
		let itemBody = '';
		if (item.task) {
			const checkbox = '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox">';
			if (item.loose) {
				if (item.tokens.length > 0 && item.tokens[0].type === 'paragraph') {
					item.tokens[0].text = checkbox + ' ' + item.tokens[0].text;
					if (item.tokens[0].tokens && item.tokens[0].tokens.length > 0 && item.tokens[0].tokens[0].type === 'text') {
						item.tokens[0].tokens[0].text = checkbox + ' ' + item.tokens[0].tokens[0].text;
					}
				} else {
					item.tokens.unshift({
						type: 'text',
						raw: checkbox + ' ',
						text: checkbox + ' '
					});
				}
			} else {
				itemBody += checkbox + ' ';
			}
		}
		itemBody += this.parser.parse(item.tokens, !!item.loose);
		return `<li>${itemBody}</li>\n`;
	}

	table(token: marked.Tokens.Table): string {
		const line = this._advanceLine(token.raw);
		let header = '';
		let cell = '';
		for (let j = 0; j < token.header.length; j++) {
			cell += this.tablecell(token.header[j]);
		}
		header += `<tr>\n${cell}</tr>\n`;
		let body = '';
		for (let j = 0; j < token.rows.length; j++) {
			const row = token.rows[j];
			cell = '';
			for (let k = 0; k < row.length; k++) {
				cell += this.tablecell(row[k]);
			}
			body += `<tr>\n${cell}</tr>\n`;
		}
		if (body) {
			body = `<tbody>${body}</tbody>`;
		}
		return `<table data-line="${line}">\n<thead>\n${header}</thead>\n${body}</table>\n`;
	}

	tablecell(token: marked.Tokens.TableCell): string {
		const content = this.parser.parseInline(token.tokens);
		const type = token.header ? 'th' : 'td';
		const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
		return tag + content + `</${type}>\n`;
	}

	code(token: marked.Tokens.Code): string {
		const line = this._advanceLine(token.raw);
		const langClass = token.lang ? ` class="language-${token.lang}"` : '';
		return `<pre data-line="${line}"><code${langClass}>${token.text}</code></pre>\n`;
	}

	hr(_token: marked.Tokens.Hr): string {
		return '<hr>\n';
	}

	html({ text }: marked.Tokens.HTML): string {
		return text;
	}
}

export class MarkdownPreviewManager extends Disposable {
	private _webviewInput: WebviewInput | undefined;
	private readonly _previewDisposables = this._register(new DisposableStore());
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _currentResource: URI | undefined;
	private _syncSource: SyncSource = null;
	private _syncDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _lineRenderer: LineMappingRenderer;

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IWebviewWorkbenchService private readonly _webviewWorkbenchService: IWebviewWorkbenchService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@ILogService private readonly _logService: ILogService,
		@IStorageService private readonly _storageService: IStorageService
	) {
		super();
		this._lineRenderer = new LineMappingRenderer();
	}

	showPreview(side?: boolean): void {
		const editor = this._editorService.activeEditor;
		if (!editor) {
			this._logService.warn('[Markdown Preview] No active editor');
			return;
		}

		const resource = editor instanceof EditorInput ? editor.resource : undefined;
		if (!resource || !resource.path.endsWith('.md')) {
			this._logService.warn('[Markdown Preview] Active editor is not a markdown file');
			return;
		}

		this._currentResource = resource;
		this._createOrUpdateWebview(resource, side);
	}

	static readonly ID = 'workbench.contrib.markdownPreview';

	toggle(): void {
		if (this._webviewInput) {
			this._closePreview();
		} else {
			this.showPreview();
		}
	}

	hasActivePreview(): boolean {
		return this._webviewInput !== undefined && !this._webviewInput.isDisposed();
	}

	static wasPreviewOpen(storageService: IStorageService, resource: URI): boolean {
		const openFiles: string[] = JSON.parse(storageService.get(PREVIEW_OPEN_FILES_KEY, StorageScope.WORKSPACE, '[]'));
		return openFiles.includes(resource.toString());
	}

	private _createOrUpdateWebview(resource: URI, side?: boolean): void {
		const title = `Preview: ${resource.path.split('/').pop() || resource.path}`;
		const parentDir = URI.joinPath(resource, '..');

		if (!this._webviewInput) {
			const initInfo: WebviewInitInfo = {
				title,
				options: {
					enableFindWidget: true,
					retainContextWhenHidden: true
				},
				contentOptions: {
					allowScripts: true,
					localResourceRoots: [parentDir]
				},
				extension: undefined
			};

			this._webviewInput = this._webviewWorkbenchService.openWebview(
				initInfo,
				MARKDOWN_PREVIEW_VIEW_TYPE,
				title,
				undefined,
				{ preserveFocus: true, group: side ? SIDE_GROUP : undefined }
			);

			this._register(
				this._webviewInput.onWillDispose(() => {
					this._clearDebounceTimer();
					this._clearSyncTimer();
					this._webviewInput = undefined;
					this._previewDisposables.clear();
					this._currentResource = undefined;
				})
			);

			const openFiles: string[] = JSON.parse(
				this._storageService.get(PREVIEW_OPEN_FILES_KEY, StorageScope.WORKSPACE, '[]')
			);
			if (!openFiles.includes(resource.toString())) {
				openFiles.push(resource.toString());
				this._storageService.store(PREVIEW_OPEN_FILES_KEY, openFiles, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
		} else {
			this._webviewInput.setWebviewTitle(title);
		}

		this._renderContent();
		this._setupScrollSync();
	}

	private _setupScrollSync(): void {
		this._previewDisposables.clear();

		this._listenToContentChanges();

		if (!this._webviewInput) {
			return;
		}

		this._previewDisposables.add(
			this._webviewInput.webview.onMessage(e => {
				const msg = e.message;
				if (msg && typeof msg === 'object' && msg.type === 'scroll-sync') {
					if (this._syncSource === 'editor') {
						return;
					}
					this._syncSource = 'preview';
					this._scrollEditorToLine(msg.lineNumber);
					this._clearSyncDebounce();
				}
			})
		);
	}

	private _getTopVisibleLine(): number {
		const editor = this._editorService.activeTextEditorControl;
		if (!editor || !('getVisibleRanges' in editor)) {
			return 1;
		}
		const ranges = (editor as { getVisibleRanges(): unknown[] }).getVisibleRanges();
		if (!ranges || ranges.length === 0) {
			return 1;
		}
		const firstRange = ranges[0] as { startLineNumber: number };
		return firstRange.startLineNumber || 1;
	}

	private _scrollEditorToLine(lineNumber: number): void {
		const editor = this._editorService.activeTextEditorControl;
		if (!editor || !('getModel' in editor) || !('revealLine' in editor)) {
			return;
		}
		const model = (editor as { getModel(): { getLineCount(): number } }).getModel();
		const maxLine = model ? model.getLineCount() : Infinity;
		const line = Math.max(1, Math.min(lineNumber, maxLine));
		(editor as unknown as { revealLine(l: number, s?: ScrollType): void }).revealLine(line, ScrollType.Smooth);
	}

	private _scrollPreviewToLine(lineNumber: number): void {
		if (!this._webviewInput) {
			return;
		}
		this._webviewInput.webview.postMessage({
			type: 'scroll-to-line',
			lineNumber: lineNumber
		});
	}

	private _listenToContentChanges(): void {
		if (!this._currentResource) {
			return;
		}

		const fileModel = this._textFileService.files.get(this._currentResource);
		if (!fileModel) {
			return;
		}

		if (!fileModel.isResolved()) {
			this._previewDisposables.add(
				this._textFileService.files.onDidResolve(e => {
					if (this._currentResource && e.model.resource.toString() === this._currentResource.toString()) {
						this._setupScrollSync();
						this._renderContent();
					}
				})
			);
			return;
		}

		const textModel = fileModel.textEditorModel;

		this._previewDisposables.add(
			textModel.onDidChangeContent(() => {
				if (this._debounceTimer) {
					clearTimeout(this._debounceTimer);
				}
				this._debounceTimer = setTimeout(() => {
					this._renderContent();
				}, 300);
			})
		);

		const editor = this._editorService.activeTextEditorControl;
		if (editor && 'onDidScrollChange' in editor) {
			const disposable = (editor as { onDidScrollChange: (listener: () => void) => Disposable }).onDidScrollChange(
				() => {
					if (this._syncSource === 'preview') {
						return;
					}
					this._syncSource = 'editor';
					const line = this._getTopVisibleLine();
					this._scrollPreviewToLine(line);
					this._clearSyncDebounce();
				}
			);
			this._previewDisposables.add(disposable);
		}
	}

	private _clearSyncDebounce(): void {
		if (this._syncDebounceTimer) {
			clearTimeout(this._syncDebounceTimer);
		}
		this._syncDebounceTimer = setTimeout(() => {
			this._syncSource = null;
		}, 150);
	}

	private _clearSyncTimer(): void {
		if (this._syncDebounceTimer) {
			clearTimeout(this._syncDebounceTimer);
			this._syncDebounceTimer = undefined;
		}
	}

	private _renderContent(): void {
		if (!this._webviewInput || !this._currentResource) {
			return;
		}

		const fileModel = this._textFileService.files.get(this._currentResource);
		if (!fileModel?.isResolved()) {
			return;
		}

		const baseDir = URI.joinPath(this._currentResource, '..');
		const textModel = fileModel.textEditorModel;
		const text = textModel.getValue();

		this._lineRenderer.reset(1);
		const renderer = this._lineRenderer;

		const parsedHtml = marked.parse(text, { renderer }) as string;
		const htmlBody = rewriteImageSrcs(parsedHtml, baseDir);

		const topLine = this._getTopVisibleLine();

		const html = `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		:root {
			--vscode-editor-foreground: #d4d4d4;
			--vscode-editor-font-family: "SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace;
			--vscode-editor-font-weight: normal;
			--vscode-editor-font-size: 14px;
			--vscode-textCodeBlock-background: rgba(127, 127, 127, 0.1);
			--text-link-decoration: none;
		}
		body {
			background-color: #1e1e1e;
			color: #d4d4d4;
		}
		pre {
			background-color: var(--vscode-textCodeBlock-background);
			white-space: pre;
		}
		pre code {
			background-color: transparent;
			padding: 0;
			border-radius: 0;
			color: var(--vscode-editor-foreground);
		}
		h1, h2, h3, h4, h5, h6 {
			font-weight: bold;
			border-bottom: 1px solid;
			padding-bottom: 0.3em;
		}
	</style>
	<style>${DEFAULT_MARKDOWN_STYLES}</style>
</head>
<body>${htmlBody}</body>
<script>
(function() {
	var scrollTimer = null;
	var ignoreScrollEvents = false;

	function getElementForLine(lineNumber) {
		return document.querySelector('[data-line="' + lineNumber + '"]');
	}

	function findClosestLine(targetLine, maxLines) {
		for (var offset = 0; offset <= maxLines; offset++) {
			var tryLine = targetLine + offset;
			if (getElementForLine(tryLine)) { return tryLine; }
			if (targetLine - offset > 0) {
				tryLine = targetLine - offset;
				if (getElementForLine(tryLine)) { return tryLine; }
			}
		}
		return null;
	}

	function reportScroll() {
		if (ignoreScrollEvents) { return; }
		if (scrollTimer) { clearTimeout(scrollTimer); }
		scrollTimer = setTimeout(function() {
			var scrollTop = window.scrollY;
			var maxScroll = document.documentElement.scrollHeight - window.innerHeight;
			if (maxScroll <= 0) { window.parent.postMessage({ type: 'scroll-sync', lineNumber: 1 }, '*'); return; }
			var pct = scrollTop / maxScroll;
			var allLines = document.querySelectorAll('[data-line]');
			var maxLineNumber = 0;
			allLines.forEach(function(el) {
				var n = parseInt(el.getAttribute('data-line'), 10);
				if (n > maxLineNumber) { maxLineNumber = n; }
			});
			if (maxLineNumber === 0) { window.parent.postMessage({ type: 'scroll-sync', lineNumber: 1 }, '*'); return; }
			var targetLine = Math.round(pct * maxLineNumber) + 1;
			targetLine = Math.max(1, Math.min(targetLine, maxLineNumber));
			window.parent.postMessage({ type: 'scroll-sync', lineNumber: targetLine }, '*');
		}, 50);
	}

	function scrollToLine(lineNumber) {
		var el = getElementForLine(lineNumber);
		if (!el) {
			var closest = findClosestLine(lineNumber, 20);
			if (closest) { el = getElementForLine(closest); }
		}
		if (el) {
			ignoreScrollEvents = true;
			var top = el.getBoundingClientRect().top + window.scrollY - 20;
			window.scrollTo({ top: top, behavior: 'smooth' });
			setTimeout(function() { ignoreScrollEvents = false; }, 200);
		}
	}

	if (window.addEventListener) {
		window.addEventListener('scroll', reportScroll, { passive: true });
	}

	if (window.addEventListener) {
		window.addEventListener('message', function(event) {
			var msg = event.data;
			if (!msg || typeof msg !== 'object') { return; }
			if (msg.type === 'scroll-to-line' && typeof msg.lineNumber === 'number') {
				scrollToLine(msg.lineNumber);
			}
		});
	}
})();
</script>
</html>`;

		this._webviewInput.webview.setHtml(html);

		this._scrollPreviewToLine(topLine);
	}

	private _clearDebounceTimer(): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = undefined;
		}
	}

	private _closePreview(): void {
		if (this._webviewInput) {
			if (this._currentResource) {
				const openFiles: string[] = JSON.parse(
					this._storageService.get(PREVIEW_OPEN_FILES_KEY, StorageScope.WORKSPACE, '[]')
				);
				const filtered = openFiles.filter((f: string) => f !== this._currentResource!.toString());
				this._storageService.store(PREVIEW_OPEN_FILES_KEY, filtered, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
			this._clearDebounceTimer();
			this._clearSyncTimer();
			this._webviewInput.dispose();
			this._webviewInput = undefined;
			this._previewDisposables.clear();
			this._currentResource = undefined;
		}
	}
}
