/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';

export const INotebookEditorModelResolverService = createDecorator<INotebookEditorModelResolverService>(
	'notebookEditorModelResolverService'
);

export interface INotebookEditorModelResolverService {
	readonly _serviceBrand: undefined;

	resolve(resource: URI, viewType?: string): Promise<any>;
	isDirty(resource: URI): boolean;
}
