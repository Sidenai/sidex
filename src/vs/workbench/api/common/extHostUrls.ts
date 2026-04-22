/*---------------------------------------------------------------------------------------------
 *  SideX — ExtHost URL handler stub. URL handlers are accepted but never dispatched;
 *  external URLs are handled by the Tauri shell plugin directly.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ExtHostUrlsShape } from './extHost.protocol.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';

export class ExtHostUrls implements ExtHostUrlsShape {
	declare _serviceBrand: undefined;

	registerUriHandler(_extension: IExtensionDescription, _handler: vscode.UriHandler): vscode.Disposable {
		return toDisposable(() => {});
	}

	async $handleExternalUri(_handle: number, _uri: UriComponents): Promise<void> {}

	async createAppUri(uri: URI): Promise<vscode.Uri> {
		return URI.revive(uri);
	}
}

export interface IExtHostUrlsService extends ExtHostUrls {}
export const IExtHostUrlsService = createDecorator<IExtHostUrlsService>('IExtHostUrlsService');
