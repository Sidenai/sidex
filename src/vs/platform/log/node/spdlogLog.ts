/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { AbstractMessageLogger, ILogger, LogLevel } from '../common/log.js';

export class SpdLogLogger extends AbstractMessageLogger implements ILogger {

	private buffer: { level: LogLevel; message: string }[] = [];
	private readonly _loggerCreationPromise: Promise<void>;
	private _loggerId: string | undefined;

	constructor(
		private readonly name: string,
		private readonly filepath: string,
		rotating: boolean,
		private readonly donotUseFormatters: boolean,
		level: LogLevel,
	) {
		super();
		this.setLevel(level);
		this._loggerCreationPromise = this._createLogger(name, filepath, rotating);
		this._register(this.onDidChangeLogLevel(level => {
			if (this._loggerId) {
				invoke('log_set_level', { loggerId: this._loggerId, level }).catch(() => {});
			}
		}));
	}

	private async _createLogger(name: string, filepath: string, rotating: boolean): Promise<void> {
		try {
			this._loggerId = await invoke<string>('log_create_logger', {
				name,
				filepath,
				rotating,
				donotUseFormatters: this.donotUseFormatters,
				level: this.getLevel()
			});

			for (const { level, message } of this.buffer) {
				await invoke('log_write', { loggerId: this._loggerId, level, message });
			}
			this.buffer = [];
		} catch (e) {
			console.error('Failed to create Tauri logger:', e);
		}
	}

	protected log(level: LogLevel, message: string): void {
		if (this._loggerId) {
			invoke('log_write', { loggerId: this._loggerId, level, message }).catch(() => {});
		} else if (this.getLevel() <= level) {
			this.buffer.push({ level, message });
		}
	}

	override flush(): void {
		if (this._loggerId) {
			invoke('log_flush', { loggerId: this._loggerId }).catch(() => {});
		} else {
			this._loggerCreationPromise.then(() => {
				if (this._loggerId) {
					invoke('log_flush', { loggerId: this._loggerId }).catch(() => {});
				}
			});
		}
	}

	override dispose(): void {
		if (this._loggerId) {
			invoke('log_drop', { loggerId: this._loggerId }).catch(() => {});
			this._loggerId = undefined;
		} else {
			this._loggerCreationPromise.then(() => {
				if (this._loggerId) {
					invoke('log_drop', { loggerId: this._loggerId }).catch(() => {});
					this._loggerId = undefined;
				}
			});
		}
		super.dispose();
	}
}
