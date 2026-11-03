import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IChatMessage, IToolCallInfo } from '../../sidexChatService.js';
import { renderMarkdown } from '../markdownRenderer.js';
import { Collapsible } from '../collapsible/collapsible.js';
import { ToolCallItem, FileEditInfo } from '../tools/toolCallItem.js';
import { ThinkingBlock } from './thinkingBlock.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';

const EDIT_TOOL_NAMES = new Set([
	'edit_file', 'write_file', 'multi_edit', 'create_file',
	'str_replace_editor', 'insert_text', 'replace_in_file',
]);

export class AssistantMessage extends Component {
	private readonly _onCopy = this._register(new Emitter<string>());
	readonly onCopy: Event<string> = this._onCopy.event;
	private _thinkingBlock: ThinkingBlock | null = null;

	get thinkingBlock(): ThinkingBlock | null { return this._thinkingBlock; }

	constructor(msg: IChatMessage, turnDurationMs?: number, onFileClick?: (path: string) => void, isThinking?: boolean, allMessages?: readonly IChatMessage[], languageService?: ILanguageService, modelService?: IModelService) {
		super('div', 'composer-rendered-message');
		this.element.style.cssText = 'display: block; outline: none; padding-top: 0px; padding-bottom: 0px; background-color: var(--composer-pane-background); opacity: 1; z-index: 99; margin-bottom: 12px;';

		// Thinking block — rendered above everything else
		if (msg.thinkingContent || isThinking) {
			this._thinkingBlock = new ThinkingBlock();
			this._thinkingBlock.appendTo(this.element);
			this._register(this._thinkingBlock);
			if (msg.thinkingContent) {
				this._thinkingBlock.setFullContent(msg.thinkingContent);
			}
			if (isThinking) {
				this._thinkingBlock.startStreaming();
			}
		}

		const hasTools = msg.toolCalls && msg.toolCalls.length > 0;
		// Gather all tool calls from all messages for cross-message read_file lookups
		const allToolCalls: IToolCallInfo[] = [];
		if (allMessages) {
			for (const m of allMessages) {
				if (m.toolCalls) { allToolCalls.push(...m.toolCalls); }
			}
		} else if (msg.toolCalls) {
			allToolCalls.push(...msg.toolCalls);
		}
		const editInfoMap = hasTools ? buildEditInfoMap(allToolCalls) : new Map<string, FileEditInfo>();

		if (hasTools) {
			const nonEditCalls = msg.toolCalls!.filter(tc => !EDIT_TOOL_NAMES.has(tc.name));
			const editCalls = msg.toolCalls!.filter(tc => EDIT_TOOL_NAMES.has(tc.name));

			// Non-edit tools: show Cursor-style descriptive collapsible
			if (nonEditCalls.length > 0) {
				const label = buildActivityLabel(nonEditCalls);
				const activitySection = new Collapsible(label);
				activitySection.appendTo(this.element);
				this._register(activitySection);

				for (const tc of nonEditCalls) {
					const item = new ToolCallItem(tc);
					item.appendTo(activitySection.body);
					this._register(item);
				}
			}

			// Edit tool calls ALWAYS render with inline diffs
			for (const tc of editCalls) {
				const editInfo = editInfoMap.get(tc.id);
				const item = new ToolCallItem(tc, editInfo, languageService, modelService);
				item.appendTo(this.element);
				this._register(item);
			}
		}

		// Markdown body
		if (msg.content) {
			const bodyWrapper = this.append('div', 'markdown-root');
			bodyWrapper.style.cssText = 'font-size: 13px; line-height: 1.5; color: var(--vscode-foreground);';
			const bodyEl = DOM.append(bodyWrapper, DOM.$('div'));
			bodyEl.style.cssText = 'display: flex; flex-direction: column; gap: 8px; white-space: normal; overflow-wrap: break-word;';
			bodyEl.innerHTML = renderMarkdown(msg.content);

			// Wire up code citation click handlers
			if (onFileClick) {
				bodyEl.querySelectorAll('.sc-citation-header').forEach(header => {
					const citation = header.parentElement;
					if (citation) {
						const file = citation.getAttribute('data-file');
						if (file) {
							(header as HTMLElement).addEventListener('click', () => onFileClick(file));
						}
					}
				});
			}
		}

		// Three-dot menu — only show when there's text content to copy
		if (msg.content) {
			const menuBtn = this.append('div', 'sc-msg-menu');
			const dots = DOM.append(menuBtn, $('button.sc-msg-menu-btn'));
			dots.title = 'Copy';
			const dotsIcon = document.createElement('span');
			dotsIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.ellipsis));
			dots.appendChild(dotsIcon);
			this.on(dots, 'click', () => {
				navigator.clipboard.writeText(msg.content).catch(() => { /* */ });
				dots.textContent = '✓';
				setTimeout(() => {
					dots.textContent = '';
					dots.appendChild(dotsIcon);
				}, 1200);
			});
		}
	}
}

const READ_TOOLS = new Set([
	'read_file', 'grep', 'glob', 'search_files',
	'batch_read', 'lsp_hover', 'lsp_definition', 'lsp_references',
]);

/**
 * Build a map of tool_call_id -> FileEditInfo by pairing read_file results
 * (old content) with subsequent edit tool calls (new content from output).
 *
 * Strategy:
 * 1. Track the last-read content per file path from read_file calls.
 * 2. For edit tools, parse the file path from the input args.
 * 3. The old content comes from a prior read_file, or defaults to empty.
 * 4. The new content comes from the tool output (the server often echoes the result),
 *    or can be reconstructed from input args for write_file/create_file.
 */
function buildEditInfoMap(toolCalls: IToolCallInfo[]): Map<string, FileEditInfo> {
	const result = new Map<string, FileEditInfo>();
	const fileContents = new Map<string, string>();
	const fileDirtySinceRead = new Set<string>();

	for (const tc of toolCalls) {
		// Track file reads to capture "before" content
		if (READ_TOOLS.has(tc.name) && tc.input && tc.output) {
			try {
				const args = JSON.parse(tc.input);
				if (args.path && typeof tc.output === 'string') {
					fileContents.set(args.path, stripLineNumbers(tc.output));
					fileDirtySinceRead.delete(args.path);
				}
			} catch { /* ignore */ }
		}

		// Process edit tools
		if (EDIT_TOOL_NAMES.has(tc.name) && tc.input && tc.status === 'done') {
			try {
				const args = JSON.parse(tc.input);
				const filePath = args.path || args.file_path || args.file || '';
				if (!filePath) { continue; }

				const oldContent = fileContents.get(filePath) || '';
				let newContent = '';

				if (tc.name === 'write_file' || tc.name === 'create_file') {
					newContent = args.content || args.text || '';
				} else if (tc.name === 'str_replace_editor' || tc.name === 'edit_file') {
					const oldStr = args.old_str ?? args.old_string;
					const newStr = args.new_str ?? args.new_string;
					if (oldStr != null && newStr != null) {
						if (oldContent && !fileDirtySinceRead.has(filePath) && oldContent.includes(oldStr)) {
							// Replacer function: a literal newStr containing "$&"
							// or "$1" must NOT be interpreted as a replace pattern.
							newContent = oldContent.replace(oldStr, () => newStr);
						} else {
							// No fresh full-file content: show the exact edit chunk.
							// This covers user/manual changes between agent edits.
							result.set(tc.id, { filePath, oldContent: oldStr, newContent: newStr });
							fileContents.set(filePath, newStr);
							fileDirtySinceRead.add(filePath);
							continue;
						}
					} else if (args.content) {
						newContent = args.content;
					} else if (tc.output) {
						newContent = tc.output;
					}
				} else if (tc.name === 'multi_edit') {
					let content = oldContent;
					const edits = args.edits || [];
					for (const edit of edits) {
						const oldText = edit.old_text ?? edit.old ?? '';
						const newText = edit.new_text ?? edit.new ?? '';
						if (oldText && content.includes(oldText)) {
							content = content.replace(oldText, () => newText);
						}
					}
					newContent = content;
				} else {
					newContent = tc.output || '';
				}

				if (newContent && newContent !== oldContent) {
					// Only create_file POSITIVELY creates a new file. write_file
					// may overwrite an existing file that was simply never read
					// in this transcript, so it must not be marked as created.
					const created = tc.name === 'create_file';
					result.set(tc.id, { filePath, oldContent, newContent, created });
					// Update tracked content so subsequent edits to the same file see the latest
					fileContents.set(filePath, newContent);
					fileDirtySinceRead.add(filePath);
				}
			} catch { /* ignore parse errors */ }
		}
	}

	return result;
}

/**
 * Strip read_file line-number prefixes ("     N|content"). Only strips when
 * EVERY non-empty line carries the prefix — otherwise the text isn't
 * read_file output and stripping would corrupt code that legitimately
 * contains "N|" at line start.
 */
function stripLineNumbers(output: string): string {
	const lines = output.split('\n');
	const prefix = /^ *\d{1,7}\|/;
	let prefixed = 0;
	let nonEmpty = 0;
	for (const line of lines) {
		if (line.trim() === '') { continue; }
		nonEmpty++;
		if (prefix.test(line)) { prefixed++; }
	}
	if (nonEmpty === 0 || prefixed < nonEmpty) { return output; }
	return lines.map(line => line.replace(prefix, '')).join('\n');
}

const READ_TOOL_SET = new Set(['read_file', 'batch_read', 'grep', 'glob', 'search_files', 'lsp_hover', 'lsp_definition', 'lsp_references']);
const SEARCH_TOOL_SET = new Set(['grep', 'glob', 'search_files', 'context_search', 'web_search']);
const SHELL_TOOL_SET = new Set(['shell', 'run_background']);

function buildActivityLabel(toolCalls: IToolCallInfo[]): string {
	let readCount = 0;
	let searchCount = 0;
	let shellCount = 0;
	const readFiles = new Set<string>();

	for (const tc of toolCalls) {
		if (READ_TOOL_SET.has(tc.name)) {
			readCount++;
			try {
				const args = JSON.parse(tc.input || '{}');
				if (args.path) {
					const name = args.path.split('/').pop() || args.path;
					readFiles.add(name);
				}
			} catch { /* */ }
		}
		if (SEARCH_TOOL_SET.has(tc.name)) { searchCount++; }
		if (SHELL_TOOL_SET.has(tc.name)) { shellCount++; }
	}

	if (readCount > 0 && searchCount === 0 && shellCount === 0) {
		const fileCount = readFiles.size || readCount;
		return `Explored ${fileCount} file${fileCount > 1 ? 's' : ''}`;
	}
	if (searchCount > 0 && readCount === 0 && shellCount === 0) {
		return `${searchCount} search${searchCount > 1 ? 'es' : ''}`;
	}
	if (shellCount > 0 && readCount === 0 && searchCount === 0) {
		return `Ran ${shellCount} command${shellCount > 1 ? 's' : ''}`;
	}

	// Mixed activities
	const parts: string[] = [];
	if (readCount > 0) { parts.push(`${readFiles.size || readCount} file${readFiles.size > 1 ? 's' : ''}`); }
	if (searchCount > 0) { parts.push(`${searchCount} search${searchCount > 1 ? 'es' : ''}`); }
	if (shellCount > 0) { parts.push(`${shellCount} command${shellCount > 1 ? 's' : ''}`); }
	return `Explored ${parts.join(', ')}`;
}
