/*---------------------------------------------------------------------------------------------
 *  SideX — ExtHost telemetry stub. Telemetry is handled by the Tauri host directly;
 *  extension telemetry loggers accept sends and report them as no-ops.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { Event, Emitter } from '../../../base/common/event.js';
import { ExtHostTelemetryShape } from './extHost.protocol.js';
import { TelemetryLevel } from '../../../platform/telemetry/common/telemetry.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../platform/extensions/common/extensions.js';

export class ExtHostTelemetry extends Disposable implements ExtHostTelemetryShape {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeTelemetryEnabled = this._register(new Emitter<boolean>());
	readonly onDidChangeTelemetryEnabled: Event<boolean> = this._onDidChangeTelemetryEnabled.event;

	private readonly _onDidChangeTelemetryConfiguration = this._register(new Emitter<vscode.TelemetryConfiguration>());
	readonly onDidChangeTelemetryConfiguration: Event<vscode.TelemetryConfiguration> =
		this._onDidChangeTelemetryConfiguration.event;

	constructor(_isWorker?: boolean) {
		super();
	}

	getTelemetryConfiguration(): boolean {
		return false;
	}
	getTelemetryDetails(): vscode.TelemetryConfiguration {
		return { isCrashEnabled: false, isErrorsEnabled: false, isUsageEnabled: false };
	}
	onExtensionError(_extension: ExtensionIdentifier, _error: Error): boolean {
		return false;
	}
	instantiateLogger(
		_extension: IExtensionDescription,
		sender: vscode.TelemetrySender,
		_options?: vscode.TelemetryLoggerOptions
	): vscode.TelemetryLogger {
		const emitter = new Emitter<boolean>();
		return {
			onDidChangeEnableStates: emitter.event,
			isUsageEnabled: false,
			isErrorsEnabled: false,
			logUsage: () => {
				sender;
			},
			logError: () => {},
			dispose: () => emitter.dispose()
		} as unknown as vscode.TelemetryLogger;
	}

	$initializeTelemetryLevel(
		_level: TelemetryLevel,
		_supportsTelemetry: boolean,
		_productConfig?: { usage: boolean; error: boolean }
	): void {}
	$onDidChangeTelemetryLevel(_level: TelemetryLevel): void {}
}

export class ExtHostTelemetryLogger {
	static validateSender(sender: vscode.TelemetrySender): void {
		if (typeof sender !== 'object' || sender === null) {
			throw new Error('telemetrySender argument is invalid');
		}
	}
}

export function isNewAppInstall(_firstSessionDate: string): boolean {
	return false;
}

export const IExtHostTelemetry = createDecorator<IExtHostTelemetry>('IExtHostTelemetry');
export interface IExtHostTelemetry extends ExtHostTelemetry, ExtHostTelemetryShape {}
