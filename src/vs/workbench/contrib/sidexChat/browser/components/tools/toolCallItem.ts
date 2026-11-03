import { Component, DOM } from '../base.js';
import { IToolCallInfo } from '../../sidexChatService.js';
import { InlineDiffView, DiffCallbacks } from '../diff/inlineDiffView.js';
import { DiffHunk } from '../diff/diffAlgorithm.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';

const EDIT_TOOLS = new Set([
	'edit_file', 'write_file', 'multi_edit', 'create_file',
	'str_replace_editor', 'insert_text', 'replace_in_file',
]);

const TOOL_DESCRIPTIONS: Record<string, (args: Record<string, unknown>) => string> = {
	read_file: (a) => `Read ${fileName(a['path'])}`,
	write_file: (a) => `Wrote ${fileName(a['path'])}`,
	edit_file: (a) => `Edited ${fileName(a['path'])}`,
	multi_edit: (a) => `Edited ${fileName(a['path'])}`,
	create_file: (a) => `Created ${fileName(a['path'])}`,
	str_replace_editor: (a) => `Edited ${fileName(a['path'])}`,
	delete_file: (a) => `Deleted ${fileName(a['path'])}`,
	shell: (a) => `Ran \`${shortCmd(a['command'])}\``,
	grep: (a) => `Searched for "${a['pattern'] || ''}"`,
	glob: (a) => `Found files matching "${a['pattern'] || a['glob'] || ''}"`,
	search_files: (a) => `Searched files for "${a['pattern'] || ''}"`,
	git_status: () => 'Checked git status',
	git_log: () => 'Viewed git log',
	git_diff_file: (a) => `Diffed ${fileName(a['path'])}`,
	git_commit: (a) => `Committed: ${a['message'] || ''}`,
	list_dir: (a) => `Listed ${a['path'] || '.'}`,
	tree: (a) => `Listed tree of ${a['path'] || '.'}`,
	batch_read: () => 'Read multiple files',
	lsp_hover: (a) => `Inspected symbol in ${fileName(a['path'])}`,
	lsp_definition: (a) => `Found definition in ${fileName(a['path'])}`,
	lsp_references: (a) => `Found references in ${fileName(a['path'])}`,
};

function fileName(path: unknown): string {
	if (typeof path !== 'string' || !path) { return 'file'; }
	const segments = path.split('/');
	return segments.pop() || path;
}

function shortCmd(cmd: unknown): string {
	if (typeof cmd !== 'string') { return '...'; }
	return cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;
}

export interface FileEditInfo {
	filePath: string;
	oldContent: string;
	newContent: string;
	/**
	 * True only when the edit POSITIVELY created a brand-new file. An empty
	 * oldContent alone means "original content unknown" (never read in this
	 * transcript) — NOT "created" — and must never trigger deletion.
	 */
	created?: boolean;
}

export class ToolCallItem extends Component {
	private _diffView: InlineDiffView | null = null;

	constructor(tc: IToolCallInfo, editInfo?: FileEditInfo, private readonly _languageService?: ILanguageService, private readonly _modelService?: IModelService) {
		super('div', 'sc-tool-call');

		if (editInfo && EDIT_TOOLS.has(tc.name)) {
			this._renderDiff(editInfo);
		} else {
			this.element.className = 'ui-shell-tool-call ui-shell-tool-call--expandable';
			this.element.style.cssText = 'margin-bottom: 6px; display: flex; flex-direction: column; gap: 6px;';
			
			const card = this.append('div', 'ui-tool-call-card ui-shell-tool-call__card');
			card.dataset.hasContent = 'true';
			card.style.cssText = 'border: 1px solid var(--cursor-stroke-secondary); border-radius: var(--cursor-radius-xl); overflow: hidden;';
			
			const header = DOM.append(card, DOM.$('div.ui-tool-call-card__header'));
			header.style.cssText = 'display: flex; align-items: center; padding: 8px 10px; cursor: pointer; gap: 6px; background-color: var(--vscode-sideBar-background); transition: background 0.15s ease;';
			header.addEventListener('mouseenter', () => header.style.backgroundColor = 'var(--vscode-list-hoverBackground)');
			header.addEventListener('mouseleave', () => header.style.backgroundColor = 'var(--vscode-sideBar-background)');

			const descRow = DOM.append(header, DOM.$('div.ui-shell-tool-call__description-row'));
			descRow.style.cssText = 'display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0;';
			
			const icon = DOM.append(descRow, DOM.$('span.ui-shell-tool-call__icon-swap'));
			const defaultIcon = DOM.append(icon, DOM.$('span.codicon.codicon-terminal.ui-shell-tool-call__icon-default'));
			defaultIcon.setAttribute('aria-hidden', 'true');
			const hoverIcon = DOM.append(icon, DOM.$('span.codicon.codicon-chevron-right.ui-shell-tool-call__icon-hover'));
			hoverIcon.setAttribute('aria-hidden', 'true');
			hoverIcon.style.display = 'none';
			icon.style.cssText = 'display: flex; align-items: center; color: var(--cursor-icon-secondary); font-size: 14px;';
			
			header.addEventListener('mouseenter', () => {
				defaultIcon.style.display = 'none';
				hoverIcon.style.display = '';
			});
			header.addEventListener('mouseleave', () => {
				defaultIcon.style.display = '';
				hoverIcon.style.display = 'none';
				hoverIcon.classList.remove('codicon-chevron-down');
				hoverIcon.classList.add('codicon-chevron-right');
			});

			const descSpan = DOM.append(descRow, DOM.$('span.ui-shell-tool-call__description'));
			descSpan.style.cssText = 'font-size: 12px; color: var(--cursor-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
			descSpan.textContent = this._getDescription(tc);

			const summary = DOM.append(descRow, DOM.$('span.ui-shell-tool-call__summary'));
			summary.style.cssText = 'font-size: 11px; color: var(--cursor-text-tertiary); margin-left: 4px;';
			summary.textContent = tc.name;

			const body = DOM.append(card, DOM.$('div.ui-tool-call-card__body'));
			body.style.cssText = 'border-top: 1px solid var(--cursor-stroke-secondary); padding: 8px 10px; font-family: var(--cursor-font-family-mono); font-size: 11px; color: var(--cursor-text-secondary); max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; display: none;';
			
			const preview = DOM.append(body, DOM.$('button.ui-shell-tool-call__output-preview.ui-shell-tool-call__output-preview--clickable.ui-shell-tool-call__output-preview--top-fade'));
			preview.setAttribute('type', 'button');
			preview.style.cssText = 'background: transparent; border: none; padding: 0; margin: 0; color: inherit; text-align: left; width: 100%; font-family: inherit; font-size: inherit; line-height: 1.4;';
			
			const outputText = DOM.append(preview, DOM.$('span.ui-shell-tool-call__output.ui-shell-tool-call__output-preview-text'));
			outputText.textContent = tc.output || '...';
			
			let expanded = false;
			this.on(header, 'click', () => {
				expanded = !expanded;
				body.style.display = expanded ? 'block' : 'none';
				hoverIcon.classList.toggle('codicon-chevron-right', !expanded);
				hoverIcon.classList.toggle('codicon-chevron-down', expanded);
			});
		}
	}

	private _getDescription(tc: IToolCallInfo): string {
		let args: Record<string, unknown> = {};
		try { args = JSON.parse(tc.input || '{}'); } catch { /* */ }

		const descFn = TOOL_DESCRIPTIONS[tc.name];
		if (descFn) {
			return descFn(args);
		}
		return tc.name.replace(/_/g, ' ');
	}

	private _renderDiff(editInfo: FileEditInfo): void {
		this.element.classList.add('sc-tool-call-diff');

		const callbacks: DiffCallbacks = {
			onAccept: (_hunk: DiffHunk) => { },
			onReject: (hunk: DiffHunk) => {
				this._revertHunk(editInfo, hunk);
			},
			onAcceptAll: () => { },
			onRejectAll: () => {
				this._revertFile(editInfo);
			},
		};

		this._diffView = new InlineDiffView(
			editInfo.filePath,
			editInfo.oldContent,
			editInfo.newContent,
			callbacks,
			this._languageService,
			this._modelService,
		);
		this._register(this._diffView);
		this._diffView.appendTo(this.element);
	}

	private _revertHunk(_editInfo: FileEditInfo, _hunk: DiffHunk): void {
		// For snippet-based diffs, revert the entire change (same as reject all)
		this._revertFile(_editInfo);
	}

	private _revertFile(editInfo: FileEditInfo): void {
		if (editInfo.created) {
			// The file was POSITIVELY created by this edit — rejecting deletes
			// it instead of leaving an empty file behind.
			this._invokeTool('delete_file', { path: editInfo.filePath }, editInfo.filePath);
			return;
		}
		if (!editInfo.oldContent) {
			// Original content unknown (file existed but was never read in
			// this transcript). A destructive guess is worse than no revert.
			this._showRevertError('Cannot revert: the original file content is not known in this session');
			return;
		}
		// Swap newContent back to oldContent in the file. Safe whether
		// editInfo contains a full file or just a snippet.
		this._invokeTool('edit_file', {
			path: editInfo.filePath,
			old_string: editInfo.newContent,
			new_string: editInfo.oldContent,
		}, editInfo.filePath);
	}

	private _invokeTool(name: string, args: Record<string, unknown>, filePath: string): void {
		const g = globalThis as unknown as {
			__TAURI_INVOKE__?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
			__TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
		};
		const invoke = g.__TAURI_INVOKE__ ?? g.__TAURI_INTERNALS__?.invoke;
		if (!invoke) {
			this._showRevertError('Revert unavailable: local tool bridge not found');
			return;
		}
		// Resolve cwd from the file path itself: tool paths are resolved
		// against cwd, and '.' (the old behavior) silently pointed reverts at
		// the wrong directory for relative paths.
		const cwd = filePath.startsWith('/')
			? filePath.slice(0, filePath.lastIndexOf('/')) || '/'
			: '.';
		invoke('agent_execute_tool', {
			request: {
				tool_call_id: `revert-${Date.now()}`,
				name,
				arguments: JSON.stringify(args),
				cwd,
			},
		}).then((resp) => {
			const r = resp as { error?: string } | null;
			if (r && r.error) {
				this._showRevertError(`Revert failed: ${r.error}`);
			}
		}).catch((e) => {
			this._showRevertError(`Revert failed: ${e instanceof Error ? e.message : String(e)}`);
		});
	}

	/** Surface revert failures in the UI instead of silently pretending success. */
	private _showRevertError(message: string): void {
		const existing = this.element.querySelector('.sc-tool-revert-error');
		if (existing) { existing.remove(); }
		const err = document.createElement('div');
		err.className = 'sc-tool-revert-error';
		err.style.cssText = 'color:var(--vscode-errorForeground);font-size:11px;padding:4px 8px;';
		err.textContent = `${message} — the file on disk was NOT restored. Re-read it to verify its state.`;
		this.element.appendChild(err);
	}
}
