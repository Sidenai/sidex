/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ProfileResult } from 'v8-inspect-profiler';
import { invoke } from '@tauri-apps/api/core';
import { timeout } from '../../../base/common/async.js';
import { ILogService } from '../../log/common/log.js';
import { IV8Profile } from '../common/profiling.js';

type BrowserWindow = any;

export class WindowProfiler {

	constructor(
		private readonly _window: BrowserWindow,
		private readonly _sessionId: string,
		@ILogService private readonly _logService: ILogService,
	) { }

	async inspect(duration: number): Promise<IV8Profile> {
		// Tauri stub: WebContents debugger is not available.
		// Profiling would need to be done via a Rust-side mechanism or DevTools protocol.
		this._logService.warn('[perf] profiling not supported in Tauri environment', this._sessionId);
		await timeout(duration);

		return { nodes: [], startTime: 0, endTime: 0 } as any;
	}
}
