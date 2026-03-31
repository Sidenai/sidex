/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Delayer } from '../../../../base/common/async.js';
import { VSBuffer, VSBufferReadableStream } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { consumeStream } from '../../../../base/common/stream.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { ITunnelService } from '../../../../platform/tunnel/common/tunnel.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { FindInFrameOptions, FoundInFrameResult } from '../../../../platform/webview/common/webviewManagerService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { WebviewThemeDataProvider } from '../browser/themeing.js';
import { WebviewInitInfo } from '../browser/webview.js';
import { WebviewElement } from '../browser/webviewElement.js';
import { WindowIgnoreMenuShortcutsManager } from './windowIgnoreMenuShortcutsManager.js';

/**
 * Webview backed by an iframe that uses Tauri IPC for native integration.
 */
export class ElectronWebviewElement extends WebviewElement {

	private readonly _webviewKeyboardHandler: WindowIgnoreMenuShortcutsManager;

	private _findStarted: boolean = false;
	private _cachedHtmlContent: string | undefined;

	private readonly _iframeDelayer = this._register(new Delayer<void>(200));

	private readonly _onFoundInFrame = this._register(new Emitter<FoundInFrameResult>());

	protected override get platform() { return 'tauri'; }

	constructor(
		initInfo: WebviewInitInfo,
		webviewThemeDataProvider: WebviewThemeDataProvider,
		@IContextMenuService contextMenuService: IContextMenuService,
		@ITunnelService tunnelService: ITunnelService,
		@IFileService fileService: IFileService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IRemoteAuthorityResolverService remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@ILogService logService: ILogService,
		@IConfigurationService configurationService: IConfigurationService,
		@INotificationService notificationService: INotificationService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
	) {
		super(initInfo, webviewThemeDataProvider,
			configurationService, contextMenuService, notificationService, environmentService,
			fileService, logService, remoteAuthorityResolverService, tunnelService, instantiationService, accessibilityService, uriIdentityService);

		this._webviewKeyboardHandler = new WindowIgnoreMenuShortcutsManager(configurationService, _nativeHostService);

		this._register(Disposable.None); // placeholder for symmetric registration count

		if (initInfo.options.enableFindWidget) {
			this._register(this.onDidHtmlChange((newContent) => {
				if (this._findStarted && this._cachedHtmlContent !== newContent) {
					this.stopFind(false);
					this._cachedHtmlContent = newContent;
				}
			}));

			this._register(this._onFoundInFrame);
			ipcRenderer.on('webview:foundInFrame', (_event: unknown, result: FoundInFrameResult) => {
				this._hasFindResult.fire(result.matches > 0);
			});
		}
	}

	override dispose(): void {
		this._webviewKeyboardHandler.didBlur();
		super.dispose();
	}

	protected override webviewContentEndpoint(iframeId: string): string {
		return `https://webview-${iframeId}.localhost`;
	}

	protected override streamToBuffer(stream: VSBufferReadableStream): Promise<ArrayBufferLike> {
		return consumeStream<VSBuffer, ArrayBufferLike>(stream, (buffers: readonly VSBuffer[]) => {
			const totalLength = buffers.reduce((prev, curr) => prev + curr.byteLength, 0);
			const ret = new ArrayBuffer(totalLength);
			const view = new Uint8Array(ret);
			let offset = 0;
			for (const element of buffers) {
				view.set(element.buffer, offset);
				offset += element.byteLength;
			}
			return ret;
		});
	}

	/**
	 * Webviews expose a stateful find API.
	 * Successive calls to find will move forward or backward through onFindResults
	 * depending on the supplied options.
	 *
	 * @param value The string to search for. Empty strings are ignored.
	 */
	public override find(value: string, previous: boolean): void {
		if (!this.element) {
			return;
		}

		if (!this._findStarted) {
			this.updateFind(value);
		} else {
			const options: FindInFrameOptions = { forward: !previous, findNext: false, matchCase: false };
			ipcRenderer.invoke('webview:findInFrame', {
				windowId: this._nativeHostService.windowId,
				frameName: this.id,
				text: value,
				options
			});
		}
	}

	public override updateFind(value: string) {
		if (!value || !this.element) {
			return;
		}

		const options: FindInFrameOptions = {
			forward: true,
			findNext: true,
			matchCase: false
		};

		this._iframeDelayer.trigger(() => {
			this._findStarted = true;
			ipcRenderer.invoke('webview:findInFrame', {
				windowId: this._nativeHostService.windowId,
				frameName: this.id,
				text: value,
				options
			});
		});
	}

	public override stopFind(keepSelection?: boolean): void {
		if (!this.element) {
			return;
		}
		this._iframeDelayer.cancel();
		this._findStarted = false;
		ipcRenderer.invoke('webview:stopFindInFrame', {
			windowId: this._nativeHostService.windowId,
			frameName: this.id,
			options: { keepSelection }
		});
		this._onDidStopFind.fire();
	}

	protected override handleFocusChange(isFocused: boolean): void {
		super.handleFocusChange(isFocused);
		if (isFocused) {
			this._webviewKeyboardHandler.didFocus();
		} else {
			this._webviewKeyboardHandler.didBlur();
		}
	}
}
