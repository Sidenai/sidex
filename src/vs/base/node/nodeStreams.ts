/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { binaryIndexOf } from '../common/buffer.js';

/**
 * A Transform-like class that splits input on the "splitter" substring.
 * In Tauri we don't have Node streams, so this operates on Uint8Arrays directly.
 */
export class StreamSplitter {
	private buffer: Uint8Array | undefined;
	private readonly splitter: Uint8Array | number;
	private readonly splitterLen: number;
	private readonly _chunks: Uint8Array[] = [];

	constructor(splitter: string | number | Uint8Array) {
		if (typeof splitter === 'number') {
			this.splitter = splitter;
			this.splitterLen = 1;
		} else if (typeof splitter === 'string') {
			const encoder = new TextEncoder();
			const buf = encoder.encode(splitter);
			this.splitter = buf.length === 1 ? buf[0] : buf;
			this.splitterLen = buf.length;
		} else {
			this.splitter = splitter.length === 1 ? splitter[0] : splitter;
			this.splitterLen = splitter.length;
		}
	}

	write(chunk: Uint8Array): Uint8Array[] {
		if (!this.buffer) {
			this.buffer = chunk;
		} else {
			const newBuffer = new Uint8Array(this.buffer.length + chunk.length);
			newBuffer.set(this.buffer);
			newBuffer.set(chunk, this.buffer.length);
			this.buffer = newBuffer;
		}

		const results: Uint8Array[] = [];
		let offset = 0;
		while (offset < this.buffer.length) {
			let index: number;
			if (typeof this.splitter === 'number') {
				index = this.buffer.indexOf(this.splitter, offset);
			} else {
				index = binaryIndexOf(this.buffer, this.splitter, offset);
			}
			if (index === -1) {
				break;
			}

			results.push(this.buffer.slice(offset, index + this.splitterLen));
			offset = index + this.splitterLen;
		}

		this.buffer = offset === this.buffer.length ? undefined : this.buffer.slice(offset);
		return results;
	}

	flush(): Uint8Array | undefined {
		const remaining = this.buffer;
		this.buffer = undefined;
		return remaining;
	}
}
