/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export class NotebookEditor {
	static readonly ID: string = 'workbench.editor.notebook';

	constructor(..._args: any[]) {}

	getId(): string {
		return NotebookEditor.ID;
	}

	getControl(): any {
		return undefined;
	}
}
