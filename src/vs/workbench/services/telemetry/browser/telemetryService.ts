/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import {
	ClassifiedEvent,
	IGDPRProperty,
	OmitMetadata,
	StrictPropertyCheck
} from '../../../../platform/telemetry/common/gdprTypings.js';
import { ITelemetryData, ITelemetryService, TelemetryLevel } from '../../../../platform/telemetry/common/telemetry.js';

// Stub: telemetry is now handled by our Rust telemetry crate
export class TelemetryService implements ITelemetryService {
	declare readonly _serviceBrand: undefined;
	readonly sendErrorTelemetry = false;
	readonly sessionId = '';
	readonly machineId = '';
	readonly sqmId = '';
	readonly devDeviceId = '';
	readonly firstSessionDate = '';
	readonly msftInternal = false;
	readonly telemetryLevel = TelemetryLevel.NONE;

	setExperimentProperty(_name: string, _value: string): void {}
	setCommonProperty(_name: string, _value: string): void {}
	publicLog(_eventName: string, _data?: ITelemetryData): void {}
	publicLog2<E extends ClassifiedEvent<OmitMetadata<T>> = never, T extends IGDPRProperty = never>(
		_eventName: string,
		_data?: StrictPropertyCheck<T, E>
	): void {}
	publicLogError(_errorEventName: string, _data?: ITelemetryData): void {}
	publicLogError2<E extends ClassifiedEvent<OmitMetadata<T>> = never, T extends IGDPRProperty = never>(
		_eventName: string,
		_data?: StrictPropertyCheck<T, E>
	): void {}
}

registerSingleton(ITelemetryService, TelemetryService, InstantiationType.Delayed);
