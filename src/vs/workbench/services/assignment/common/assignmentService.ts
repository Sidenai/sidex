/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IAssignmentService } from '../../../../platform/assignment/common/assignment.js';

export interface IAssignmentFilter {
	exclude(assignment: string): boolean;
	onDidChange: Event<void>;
}

export const IWorkbenchAssignmentService = createDecorator<IWorkbenchAssignmentService>('assignmentService');

export interface IWorkbenchAssignmentService extends IAssignmentService {
	getCurrentExperiments(): Promise<string[] | undefined>;
	addTelemetryAssignmentFilter(filter: IAssignmentFilter): void;
}

class NullWorkbenchAssignmentService implements IWorkbenchAssignmentService {
	declare readonly _serviceBrand: undefined;
	readonly onDidRefetchAssignments = Event.None;
	async getTreatment<T extends string | number | boolean>(_name: string): Promise<T | undefined> {
		return undefined;
	}
	async getCurrentExperiments(): Promise<string[] | undefined> {
		return undefined;
	}
	addTelemetryAssignmentFilter(_filter: IAssignmentFilter): void {}
}

registerSingleton(IWorkbenchAssignmentService, NullWorkbenchAssignmentService, InstantiationType.Delayed);
