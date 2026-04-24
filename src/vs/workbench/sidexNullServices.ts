/*---------------------------------------------------------------------------------------------
 *  SideX - A fast, native code editor
 *  Copyright (c) Siden Technologies, Inc. MIT Licensed.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { createDecorator } from '../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../base/common/event.js';
import { IWorkbenchIssueService } from '../workbench/contrib/issue/common/issue.js';

class NullWorkbenchIssueService implements IWorkbenchIssueService {
	readonly _serviceBrand: undefined;
	openReporter(_dataOverrides?: any): Promise<void> {
		return Promise.resolve();
	}
}

registerSingleton(IWorkbenchIssueService, NullWorkbenchIssueService, InstantiationType.Delayed);
// --- IAccessibleViewService ---
const IAccessibleViewService = createDecorator<IAccessibleViewService>('accessibleViewService');
interface IAccessibleViewService {
	readonly _serviceBrand: undefined;
	show(..._args: any[]): void;
}
class NullAccessibleViewService implements IAccessibleViewService {
	declare readonly _serviceBrand: undefined;
	show() {}
}
registerSingleton(IAccessibleViewService, NullAccessibleViewService, InstantiationType.Delayed);

// --- notebookEditorModelResolverService ---
const INotebookEditorModelResolverService = createDecorator<INotebookEditorModelResolverService>(
	'notebookEditorModelResolverService'
);
interface INotebookEditorModelResolverService {
	readonly _serviceBrand: undefined;
}
class NullNotebookEditorModelResolverService implements INotebookEditorModelResolverService {
	declare readonly _serviceBrand: undefined;
}
registerSingleton(
	INotebookEditorModelResolverService,
	NullNotebookEditorModelResolverService,
	InstantiationType.Delayed
);

// --- notebookService ---
const INotebookService = createDecorator<INotebookService>('notebookService');
interface INotebookService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeNotebookActiveKernel: Event<void>;
	readonly onDidAddNotebookDocument: Event<void>;
	readonly onDidRemoveNotebookDocument: Event<void>;
	getNotebookTextModels(): Iterable<unknown>;
}
class NullNotebookService implements INotebookService {
	declare readonly _serviceBrand: undefined;
	private _e = new Emitter<void>();
	readonly onDidChangeNotebookActiveKernel = this._e.event;
	readonly onDidAddNotebookDocument = this._e.event;
	readonly onDidRemoveNotebookDocument = this._e.event;
	getNotebookTextModels() {
		return [];
	}
}
registerSingleton(INotebookService, NullNotebookService, InstantiationType.Delayed);

// --- INotebookEditorService ---
const INotebookEditorService = createDecorator<INotebookEditorService>('notebookEditorService');
interface INotebookEditorService {
	readonly _serviceBrand: undefined;
}
class NullNotebookEditorService implements INotebookEditorService {
	declare readonly _serviceBrand: undefined;
}
registerSingleton(INotebookEditorService, NullNotebookEditorService, InstantiationType.Delayed);

// --- INotebookKernelService ---
const INotebookKernelService = createDecorator<INotebookKernelService>('notebookKernelService');
interface INotebookKernelService {
	readonly _serviceBrand: undefined;
}
class NullNotebookKernelService implements INotebookKernelService {
	declare readonly _serviceBrand: undefined;
}
registerSingleton(INotebookKernelService, NullNotebookKernelService, InstantiationType.Delayed);

// --- INotebookExecutionStateService ---
const INotebookExecutionStateService = createDecorator<INotebookExecutionStateService>(
	'INotebookExecutionStateService'
);
interface INotebookExecutionStateService {
	readonly _serviceBrand: undefined;
}
class NullNotebookExecutionStateService implements INotebookExecutionStateService {
	declare readonly _serviceBrand: undefined;
}
registerSingleton(INotebookExecutionStateService, NullNotebookExecutionStateService, InstantiationType.Delayed);

// --- INotebookRendererMessagingService ---
const INotebookRendererMessagingService = createDecorator<INotebookRendererMessagingService>(
	'INotebookRendererMessagingService'
);
interface INotebookRendererMessagingService {
	readonly _serviceBrand: undefined;
}
class NullNotebookRendererMessagingService implements INotebookRendererMessagingService {
	declare readonly _serviceBrand: undefined;
}
registerSingleton(INotebookRendererMessagingService, NullNotebookRendererMessagingService, InstantiationType.Delayed);

// --- INotebookCellStatusBarService ---
const INotebookCellStatusBarService = createDecorator<INotebookCellStatusBarService>('notebookCellStatusBarService');
interface INotebookCellStatusBarService {
	readonly _serviceBrand: undefined;
}
class NullNotebookCellStatusBarService implements INotebookCellStatusBarService {
	declare readonly _serviceBrand: undefined;
}
registerSingleton(INotebookCellStatusBarService, NullNotebookCellStatusBarService, InstantiationType.Delayed);
