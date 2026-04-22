/*---------------------------------------------------------------------------------------------
 *  SideX - A fast, native code editor
 *  Copyright (c) Siden Technologies, Inc. MIT Licensed.
 *--------------------------------------------------------------------------------------------*/

export interface ICellViewModel {
	readonly id: string;
	handle: number;
	uri: any;
	cellKind: any;
	language: string;
	getText(): string;
}

export interface CellWebviewFindMatch {
	readonly index: number;
	readonly searchPreviewInfo?: any;
}

export interface CellFindMatchWithIndex {
	cell: ICellViewModel;
	index: number;
	length: number;
	contentMatches: any[];
	webviewMatches: CellWebviewFindMatch[];
}

export function getNotebookEditorFromEditorPane(_editorPane: any): any {
	return undefined;
}
