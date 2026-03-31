/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { listenStream } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
import { IChecksumService } from '../common/checksumService.js';
import { IFileService } from '../../files/common/files.js';

export class ChecksumService implements IChecksumService {

	declare readonly _serviceBrand: undefined;

	constructor(@IFileService private readonly fileService: IFileService) { }

	async checksum(resource: URI): Promise<string> {
		const stream = (await this.fileService.readFileStream(resource)).value;
		return new Promise<string>((resolve, reject) => {
			const chunks: Uint8Array[] = [];

			listenStream(stream, {
				onData: data => chunks.push(data.buffer),
				onError: error => reject(error),
				onEnd: async () => {
					try {
						const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
						const combined = new Uint8Array(totalLength);
						let offset = 0;
						for (const chunk of chunks) {
							combined.set(chunk, offset);
							offset += chunk.length;
						}
						const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
						const hashArray = new Uint8Array(hashBuffer);
						const base64 = btoa(String.fromCharCode(...hashArray));
						resolve(base64.replace(/=+$/, ''));
					} catch (error) {
						reject(error);
					}
				}
			});
		});
	}
}
