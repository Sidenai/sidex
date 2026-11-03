import { Component, DOM, $ } from '../base.js';
import { IChatMessage } from '../../sidexChatService.js';
import { renderMarkdown } from '../markdownRenderer.js';

export class UserMessage extends Component {
	private _confirmCard: HTMLElement | null = null;

	constructor(msg: IChatMessage, onRevert?: () => void) {
		super('div', 'composer-rendered-message');
		this.element.style.cssText = 'display: block; outline: none; padding-top: 10px; margin-bottom: 6px; position: relative; width: 100%;';

		const container = this.append('div', 'composer-human-message-container');
		container.style.cssText = 'display: flex; align-items: flex-start; gap: 8px; width: 100%; background-color: color-mix(in srgb, var(--vscode-sideBar-background) 60%, transparent); outline: none; border-radius: 12px;';

		const wrapper = DOM.append(container, $('div'));
		wrapper.style.cssText = 'display: flex; flex-direction: column; align-items: flex-end; width: 100%;';

		const messageBox = DOM.append(wrapper, $('div.composer-human-message'));
		messageBox.style.cssText = 'background-color: color-mix(in srgb, var(--vscode-input-background) 90%, #181818); cursor: pointer; padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.5; color: var(--vscode-foreground); word-wrap: break-word; position: relative; max-width: 100%; box-sizing: border-box;';

		const contentEl = DOM.append(messageBox, $('div.composer-human-message-content'));

		const visibleContent = stripHiddenContext(msg.content);
		const attachmentPreviews = extractAttachmentPreviews(visibleContent);
		if (attachmentPreviews.length > 0) {
			renderAttachmentPreviewStrip(contentEl, attachmentPreviews);
		}

		const flexRow = DOM.append(contentEl, $('div'));
		flexRow.style.cssText = 'display: flex; width: 100%; justify-content: space-between; box-sizing: border-box; gap: 10px; align-items: center;';
		
		const textCol = DOM.append(flexRow, $('div'));
		textCol.style.cssText = 'min-width: 0; display: flex; flex-direction: column;';

		textCol.dir = 'ltr';
		textCol.style.cssText += ' line-height: 1.5; font-family: inherit; overflow-wrap: break-word;';
		const textContent = stripAttachmentDisplayMarkdown(visibleContent).trim();
		if (textContent) {
			textCol.innerHTML = renderMarkdown(textContent);
		}

		if (onRevert && msg.checkpointLabel) {
			const btnCol = DOM.append(flexRow, $('div'));
			btnCol.style.cssText = 'display: flex; flex-direction: column; justify-content: flex-end; align-self: flex-end; width: 20px; flex-shrink: 0; align-items: flex-end; position: relative;';

			const revertBtn = DOM.append(btnCol, $('button.sc-user-msg-revert'));
			revertBtn.innerHTML = '<span class="codicon codicon-restore" style="font-size: 16px;"></span>';
			revertBtn.style.cssText = 'background: transparent; border: none; color: var(--vscode-descriptionForeground); display: flex; width: 20px; height: 20px; align-items: center; justify-content: center; box-sizing: border-box; flex-shrink: 0; border-radius: 5px; cursor: pointer; transition: opacity 0.15s ease; opacity: 0;';
			
			revertBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this._showConfirmation(onRevert);
			});
			
			messageBox.addEventListener('mouseenter', () => revertBtn.style.opacity = '0.6');
			messageBox.addEventListener('mouseleave', () => revertBtn.style.opacity = '0');
			revertBtn.addEventListener('mouseenter', () => { revertBtn.style.opacity = '1'; revertBtn.style.background = 'var(--vscode-toolbar-hoverBackground)'; });
			revertBtn.addEventListener('mouseleave', () => { revertBtn.style.background = 'transparent'; });
		}
	}

	private _showConfirmation(onRevert: () => void): void {
		if (this._confirmCard) { return; }

		const card = document.createElement('div');
		card.className = 'sc-revert-confirm';
		card.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; margin: 6px 0 8px; background: var(--vscode-editor-background); border: 1px solid var(--cursor-stroke-secondary); border-radius: 8px; font-family: var(--cursor-font-family-sans);';

		const text = document.createElement('span');
		text.className = 'sc-revert-confirm-text';
		text.textContent = 'Discard changes after this point?';
		text.style.cssText = 'font-size: 12px; color: var(--vscode-descriptionForeground);';
		card.appendChild(text);

		const actions = document.createElement('div');
		actions.className = 'sc-revert-confirm-actions';
		actions.style.cssText = 'display: flex; align-items: center; gap: 6px;';

		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'sc-revert-confirm-btn sc-revert-cancel';
		cancelBtn.textContent = 'Cancel';
		cancelBtn.style.cssText = 'padding: 3px 10px; border-radius: 4px; font-size: 11px; background: transparent; border: 1px solid rgba(255,255,255,0.1); color: var(--vscode-descriptionForeground); cursor: pointer;';
		cancelBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this._dismissConfirmation();
		});
		actions.appendChild(cancelBtn);

		const continueBtn = document.createElement('button');
		continueBtn.className = 'sc-revert-confirm-btn sc-revert-continue';
		continueBtn.textContent = 'Continue';
		continueBtn.style.cssText = 'padding: 3px 10px; border-radius: 4px; font-size: 11px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); color: var(--vscode-foreground); cursor: pointer;';
		continueBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this._dismissConfirmation();
			onRevert();
		});
		actions.appendChild(continueBtn);

		card.appendChild(actions);
		this._confirmCard = card;

		if (this.element.nextSibling) {
			this.element.parentNode?.insertBefore(card, this.element.nextSibling);
		} else {
			this.element.parentNode?.appendChild(card);
		}
	}

	private _dismissConfirmation(): void {
		if (this._confirmCard) {
			this._confirmCard.remove();
			this._confirmCard = null;
		}
	}

	override dispose(): void {
		this._dismissConfirmation();
		super.dispose();
	}
}

function stripHiddenContext(content: string): string {
	return content
		.replace(/<context\b[^>]*>[\s\S]*?<\/context>\s*/g, '')
		.replace(/<attachments>[\s\S]*?<\/attachments>\s*/g, '')
		.trim();
}

interface AttachmentPreview {
	kind: 'image' | 'file';
	name: string;
	path: string;
}

function extractAttachmentPreviews(content: string): AttachmentPreview[] {
	const previews: AttachmentPreview[] = [];
	for (const match of content.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
		const path = match[2].trim();
		previews.push({
			kind: 'image',
			name: match[1].trim() || basename(path),
			path,
		});
	}
	for (const match of content.matchAll(/^Attached file:\s+`([^`]+)`\s*$/gm)) {
		const path = match[1].trim();
		previews.push({
			kind: 'file',
			name: basename(path),
			path,
		});
	}
	return previews;
}

function stripAttachmentDisplayMarkdown(content: string): string {
	return content
		.replace(/!\[([^\]]*)\]\(([^)]+)\)\s*/g, '')
		.replace(/^Attached file:\s+`[^`]+`\s*$/gm, '')
		.trim();
}

function renderAttachmentPreviewStrip(parent: HTMLElement, previews: AttachmentPreview[]): void {
	const strip = DOM.append(parent, $('div.sc-user-attachment-strip'));
	const scroller = DOM.append(strip, $('div.sc-user-attachment-scroll'));
	for (const preview of previews) {
		const pill = DOM.append(scroller, $('div.context-pill'));
		pill.classList.add(preview.kind === 'image' ? 'context-pill-image' : 'context-pill-file');
		pill.title = preview.name;
		pill.setAttribute('aria-label', preview.name);
		if (preview.kind === 'image') {
			const imageContainer = DOM.append(pill, $('div.image-pill-container'));
			const img = DOM.append(imageContainer, $('img.image-pill-img')) as HTMLImageElement;
			img.alt = 'Attached image';
			img.loading = 'lazy';
			void loadImagePreview(img, preview.path);
		} else {
			const icon = DOM.append(pill, $('span.codicon.codicon-file'));
			icon.setAttribute('aria-hidden', 'true');
			const label = DOM.append(pill, $('span.context-pill-file-label'));
			label.textContent = preview.name;
		}
	}
}

async function loadImagePreview(img: HTMLImageElement, path: string): Promise<void> {
	if (/^(https?:|vscode-file:)/i.test(path)) {
		img.src = path;
		return;
	}
	const localPath = localPathFromAttachment(path);
	const invoke = getTauriInvoke();
	if (!invoke || !localPath) {
		return;
	}
	try {
		const bytes = await invoke('read_file_bytes', { path: localPath }) as number[] | Uint8Array;
		const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		img.src = `data:${mimeFromPath(localPath)};base64,${base64FromBytes(data)}`;
	} catch (error) {
		console.warn('[sidex-chat] failed to load attachment preview:', error);
	}
}

function localPathFromAttachment(path: string): string {
	if (path.startsWith('file://')) {
		try {
			return decodeURIComponent(new URL(path).pathname);
		} catch {
			return path.replace(/^file:\/\//, '');
		}
	}
	return path;
}

function getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
	const g = globalThis as unknown as {
		__TAURI_INVOKE__?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
		__TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
	};
	return g.__TAURI_INVOKE__ ?? g.__TAURI_INTERNALS__?.invoke ?? null;
}

function base64FromBytes(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

function mimeFromPath(path: string): string {
	const lowered = path.toLowerCase();
	if (lowered.endsWith('.jpg') || lowered.endsWith('.jpeg')) {
		return 'image/jpeg';
	}
	if (lowered.endsWith('.gif')) {
		return 'image/gif';
	}
	if (lowered.endsWith('.webp')) {
		return 'image/webp';
	}
	return 'image/png';
}

function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
