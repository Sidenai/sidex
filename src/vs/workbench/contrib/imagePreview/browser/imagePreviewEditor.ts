/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, Dimension, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { extname } from '../../../../base/common/path.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ImagePreviewEditorInput } from './imagePreviewEditorInput.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';

const INFO_BAR_HEIGHT = 26;
const SCROLL_STEP = 40;
const ZOOM_FACTOR = 1.2;

const MIME_TYPES: Record<string, string> = {
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.jpe': 'image/jpeg',
	'.gif': 'image/gif',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
};

export class ImagePreviewEditor extends EditorPane {

	static readonly ID = 'workbench.editor.imagePreview';

	private container!: HTMLElement;
	private scrollable!: DomScrollableElement;
	private scrollContent!: HTMLElement;
	private imageWrapper!: HTMLElement;
	private imgElement: HTMLImageElement | undefined;
	private infoBar: HTMLElement | undefined;
	private readonly inputDisposable = this._register(new MutableDisposable());

	private fitMode = true;
	private zoomLevel = 0;
	private cachedByteLength = 0;
	private currentDimension: Dimension | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configService: IConfigurationService,
	) {
		super(ImagePreviewEditor.ID, group, telemetryService, themeService, storageService);
		this._register(this.configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('mediaPreview.showInfo')) {
				this.toggleInfoBar();
			}
		}));
	}

	// --- Config helpers ---

	private get maxScale(): number {
		return Math.max(1, (this.configService.getValue<number>('mediaPreview.maxZoom') || 1200) / 100);
	}

	private get showInfo(): boolean {
		return this.configService.getValue<boolean>('mediaPreview.showInfo') !== false;
	}

	private get infoBarHeight(): number {
		return this.infoBar ? INFO_BAR_HEIGHT : 0;
	}

	// --- Editor lifecycle ---

	protected createEditor(parent: HTMLElement): void {
		this.container = $('.image-preview-editor');
		this.container.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;outline:none';
		this.container.tabIndex = 0;

		this.scrollContent = $('.image-preview-scroll-content');
		this.scrollContent.style.overflow = 'hidden';

		this.imageWrapper = $('.image-preview-wrapper');
		this.imageWrapper.style.cssText = 'display:flex;align-items:center;justify-content:center';
		this.scrollContent.appendChild(this.imageWrapper);

		this.scrollable = this._register(new DomScrollableElement(this.scrollContent, {
			horizontal: ScrollbarVisibility.Auto,
			vertical: ScrollbarVisibility.Auto,
			useShadows: false,
		}));
		this.scrollable.getDomNode().style.flex = '1';
		this.container.appendChild(this.scrollable.getDomNode());

		this._register(addDisposableListener(this.container, EventType.WHEEL, (e: WheelEvent) => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				e.deltaY < 0 ? this.zoomIn() : this.zoomOut();
			}
		}, { passive: false }));

		this._register(addDisposableListener(this.container, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (this.handleKeyDown(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
		}));

		parent.appendChild(this.container);
	}

	private handleKeyDown(e: KeyboardEvent): boolean {
		const mod = e.ctrlKey || e.metaKey;
		switch (e.key) {
			case 'ArrowUp': this.scrollBy(0, -SCROLL_STEP); return true;
			case 'ArrowDown': this.scrollBy(0, SCROLL_STEP); return true;
			case 'ArrowLeft': this.scrollBy(-SCROLL_STEP, 0); return true;
			case 'ArrowRight': this.scrollBy(SCROLL_STEP, 0); return true;
			case '+': case '=': if (mod) { this.zoomIn(); return true; } return false;
			case '-': case '_': if (mod) { this.zoomOut(); return true; } return false;
			case '0': if (mod) { this.resetZoom(); return true; } return false;
			case 'Home': this.scrollable.setScrollPosition({ scrollTop: 0, scrollLeft: 0 }); return true;
			case 'End': this.scrollable.setScrollPosition({ scrollTop: 999999, scrollLeft: 999999 }); return true;
			case 'PageUp': this.scrollBy(0, -(this.currentDimension?.height ?? 300)); return true;
			case 'PageDown': this.scrollBy(0, this.currentDimension?.height ?? 300); return true;
			default: return false;
		}
	}

	private scrollBy(dx: number, dy: number): void {
		const p = this.scrollable.getScrollPosition();
		this.scrollable.setScrollPosition({ scrollLeft: p.scrollLeft + dx, scrollTop: p.scrollTop + dy });
	}

	override async setInput(input: ImagePreviewEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this.loadImage(input, token);
	}

	// --- Image loading ---

	private async loadImage(input: ImagePreviewEditorInput, token: CancellationToken): Promise<void> {
		const resource = input.resource;
		if (!resource) {
			return;
		}

		this.disposeImage();
		this.fitMode = true;
		this.zoomLevel = 0;
		this.cachedByteLength = 0;

		try {
			const file = await this.fileService.readFile(resource);
			if (token.isCancellationRequested) { return; }

			const ext = extname(resource.fsPath || resource.path).toLowerCase();
			const blob = new Blob([file.value.buffer.slice(0)], { type: MIME_TYPES[ext] ?? 'application/octet-stream' });
			const url = URL.createObjectURL(blob);

			const img = document.createElement('img');
			img.style.cssText = 'object-fit:contain;flex-shrink:0;cursor:zoom-in';
			img.draggable = false;
			img.addEventListener('click', () => this.zoomIn());

			const loaded = new Promise<void>((ok, fail) => {
				img.onload = () => ok();
				img.onerror = () => fail(new Error('Failed to load image'));
			});
			img.src = url;
			this.imgElement = img;

			await loaded;
			if (token.isCancellationRequested) { URL.revokeObjectURL(url); return; }

			this.imageWrapper.appendChild(img);
			this.cachedByteLength = file.value.buffer.byteLength;
			this.inputDisposable.value = { dispose: () => URL.revokeObjectURL(url) };

			if (this.showInfo) {
				this.createInfoBar();
			}

			this.applyImageSize(true);
		} catch (err) {
			const el = $('.image-preview-error');
			el.textContent = `Failed to load image: ${err instanceof Error ? err.message : String(err)}`;
			el.style.cssText = 'padding:20px;opacity:0.7';
			this.imageWrapper.appendChild(el);
		}
	}

	// --- Zoom / layout ---

	private applyImageSize(center: boolean): void {
		const img = this.imgElement;
		if (!img || !this.currentDimension) { return; }

		const availW = this.currentDimension.width;
		const availH = this.currentDimension.height - this.infoBarHeight;
		const natW = img.naturalWidth;
		const natH = img.naturalHeight;
		if (natW === 0 || natH === 0) { return; }

		let displayW: number, displayH: number, zoomPct: number;

		if (this.fitMode) {
			const fit = Math.min(1, availW / natW, availH / natH);
			displayW = Math.round(natW * fit);
			displayH = Math.round(natH * fit);
			zoomPct = Math.round(fit * 100);
		} else {
			const scale = Math.min(Math.pow(ZOOM_FACTOR, this.zoomLevel), this.maxScale);
			displayW = Math.round(natW * scale);
			displayH = Math.round(natH * scale);
			zoomPct = Math.round(scale * 100);
		}

		img.style.width = `${displayW}px`;
		img.style.height = `${displayH}px`;
		img.style.imageRendering = (displayW > natW || displayH > natH) ? 'pixelated' : 'auto';

		const atMax = !this.fitMode && Math.pow(ZOOM_FACTOR, this.zoomLevel) >= this.maxScale;
		img.style.cursor = atMax ? 'default' : 'zoom-in';

		const wW = Math.max(displayW, availW);
		const wH = Math.max(displayH, availH);
		this.imageWrapper.style.width = `${wW}px`;
		this.imageWrapper.style.height = `${wH}px`;

		this.scrollable.scanDomNode();

		if (center) {
			this.scrollable.setScrollPosition({
				scrollLeft: Math.max(0, Math.round((wW - availW) / 2)),
				scrollTop: Math.max(0, Math.round((wH - availH) / 2)),
			});
		}

		this.updateInfoBar(zoomPct);
	}

	private zoomIn(): void {
		if (this.fitMode) {
			const fitScale = this.getFitScale();
			this.zoomLevel = Math.ceil(Math.log(fitScale) / Math.log(ZOOM_FACTOR)) + 1;
			this.fitMode = false;
		} else if (Math.pow(ZOOM_FACTOR, this.zoomLevel) >= this.maxScale) {
			return;
		} else {
			this.zoomLevel++;
		}
		this.applyImageSize(true);
	}

	private zoomOut(): void {
		if (this.fitMode) { return; }
		const fitLevel = Math.ceil(Math.log(this.getFitScale()) / Math.log(ZOOM_FACTOR));
		if (this.zoomLevel - 1 <= fitLevel) {
			this.fitMode = true;
			this.zoomLevel = 0;
		} else {
			this.zoomLevel--;
		}
		this.applyImageSize(true);
	}

	private resetZoom(): void {
		this.fitMode = true;
		this.zoomLevel = 0;
		this.applyImageSize(true);
	}

	private getFitScale(): number {
		if (!this.imgElement || !this.currentDimension) { return 1; }
		const availW = this.currentDimension.width;
		const availH = this.currentDimension.height - this.infoBarHeight;
		return Math.min(1, availW / this.imgElement.naturalWidth, availH / this.imgElement.naturalHeight);
	}

	// --- Info bar ---

	private createInfoBar(): void {
		this.infoBar = $('.image-preview-info');
		this.infoBar.style.cssText = `padding:4px 12px;font-size:12px;opacity:0.7;text-align:center;height:${INFO_BAR_HEIGHT}px;line-height:${INFO_BAR_HEIGHT}px;flex-shrink:0`;
		this.container.appendChild(this.infoBar);
	}

	private updateInfoBar(zoomPct: number): void {
		if (!this.infoBar || !this.imgElement) { return; }
		const { naturalWidth: w, naturalHeight: h } = this.imgElement;
		const b = this.cachedByteLength;
		const size = b > 1048576 ? `${(b / 1048576).toFixed(2)} MB` : `${(b / 1024).toFixed(1)} KB`;
		const zoom = this.fitMode ? `Fit (${zoomPct}%)` : `${zoomPct}%`;
		this.infoBar.textContent = `${w} × ${h} — ${size} — ${zoom}`;
	}

	private toggleInfoBar(): void {
		if (this.showInfo && !this.infoBar && this.imgElement) {
			this.createInfoBar();
			this.applyImageSize(false);
		} else if (!this.showInfo && this.infoBar) {
			this.infoBar.remove();
			this.infoBar = undefined;
			this.applyImageSize(false);
		}
	}

	// --- Cleanup ---

	private disposeImage(): void {
		this.inputDisposable.clear();
		if (this.imgElement) {
			URL.revokeObjectURL(this.imgElement.src);
			this.imgElement.remove();
			this.imgElement = undefined;
		}
		if (this.infoBar) {
			this.infoBar.remove();
			this.infoBar = undefined;
		}
	}

	override clearInput(): void {
		this.disposeImage();
		super.clearInput();
	}

	layout(dimension: Dimension): void {
		this.currentDimension = dimension;
		this.container.style.width = `${dimension.width}px`;
		this.container.style.height = `${dimension.height}px`;
		this.applyImageSize(false);
	}

	override focus(): void {
		super.focus();
		this.container?.focus();
	}
}
