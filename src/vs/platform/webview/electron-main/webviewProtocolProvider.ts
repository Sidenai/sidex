/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { AppResourcePath, COI, FileAccess, Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../files/common/files.js';


export class WebviewProtocolProvider implements IDisposable {

	private static validWebviewFilePaths = new Map<string, { readonly mime: string }>([
		['/index.html', { mime: 'text/html' }],
		['/fake.html', { mime: 'text/html' }],
		['/service-worker.js', { mime: 'application/javascript' }],
	]);

	constructor(
		@IFileService private readonly _fileService: IFileService
	) {
		// Tauri stub: Register protocol handler via Rust backend
		invoke('register_webview_protocol', { scheme: Schemas.vscodeWebview }).catch(() => {});
	}

	dispose(): void {
		invoke('unregister_webview_protocol', { scheme: Schemas.vscodeWebview }).catch(() => {});
	}

	private async handleWebviewRequest(request: { url: string }): Promise<Response> {
		try {
			const uri = URI.parse(request.url);
			const entry = WebviewProtocolProvider.validWebviewFilePaths.get(uri.path);
			if (entry) {
				const relativeResourcePath: AppResourcePath = `vs/workbench/contrib/webview/browser/pre${uri.path}`;
				const url = FileAccess.asFileUri(relativeResourcePath);

				const content = await this._fileService.readFile(url);
				return new Response(content.value.buffer.buffer as ArrayBuffer, {
					headers: {
						'Content-Type': entry.mime,
						...COI.getHeadersFromQuery(request.url),
						'Cross-Origin-Resource-Policy': 'cross-origin',
					}
				});
			} else {
				return new Response(null, { status: 403 });
			}
		} catch {
			// noop
		}
		return new Response(null, { status: 500 });
	}
}
