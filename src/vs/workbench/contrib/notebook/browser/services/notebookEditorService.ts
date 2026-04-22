/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Event, Emitter as _Emitter } from '../../../../../base/common/event.js';
import type { NotebookEditorWidget } from '../notebookEditorWidget.js';
import { URI } from '../../../../../base/common/uri.js';

export const INotebookEditorService = createDecorator<INotebookEditorService>('notebookEditorService');

export interface INotebookEditorService {
	readonly _serviceBrand: undefined;

	readonly onDidAddNotebookEditor: Event<NotebookEditorWidget>;
	readonly onDidRemoveNotebookEditor: Event<NotebookEditorWidget>;

	retrieveWidget(accessor: any, group: any, input: any, creationOptions?: any, dimension?: any): any;
	retrieveExistingWidgetFromURI(resource: URI): any | undefined;
	retrieveAllExistingWidgets(): NotebookEditorWidget[];
	listNotebookEditors(): readonly NotebookEditorWidget[];
}
