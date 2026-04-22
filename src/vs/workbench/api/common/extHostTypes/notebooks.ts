/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export enum NotebookCellKind {
	Markup = 1,
	Code = 2
}

export class NotebookRange {
	readonly start: number;
	readonly end: number;
	readonly isEmpty: boolean;

	constructor(start: number, end: number) {
		this.start = Math.min(start, end);
		this.end = Math.max(start, end);
		this.isEmpty = this.start === this.end;
	}

	with(change: { start?: number; end?: number }): NotebookRange {
		return new NotebookRange(change.start ?? this.start, change.end ?? this.end);
	}
}

export class NotebookCellOutputItem {
	static text(value: string, mime?: string): NotebookCellOutputItem {
		const encoder = new TextEncoder();
		return new NotebookCellOutputItem(encoder.encode(value), mime ?? 'text/plain');
	}

	static json(value: any, mime?: string): NotebookCellOutputItem {
		const rawStr = JSON.stringify(value, undefined, '\t');
		return NotebookCellOutputItem.text(rawStr, mime ?? 'text/x-json');
	}

	static stdout(value: string): NotebookCellOutputItem {
		return NotebookCellOutputItem.text(value, 'application/vnd.code.notebook.stdout');
	}

	static stderr(value: string): NotebookCellOutputItem {
		return NotebookCellOutputItem.text(value, 'application/vnd.code.notebook.stderr');
	}

	static error(value: Error): NotebookCellOutputItem {
		return NotebookCellOutputItem.text(
			JSON.stringify({
				name: value.name,
				message: value.message,
				stack: value.stack
			}),
			'application/vnd.code.notebook.error'
		);
	}

	mime: string;
	data: Uint8Array;

	constructor(data: Uint8Array, mime: string) {
		this.data = data;
		this.mime = mime;
	}
}

export class NotebookCellOutput {
	items: NotebookCellOutputItem[];
	metadata?: Record<string, any>;

	constructor(items: NotebookCellOutputItem[], metadata?: Record<string, any>) {
		this.items = items;
		this.metadata = metadata;
	}
}

export class NotebookCellData {
	kind: NotebookCellKind;
	value: string;
	languageId: string;
	outputs?: NotebookCellOutput[];
	metadata?: Record<string, any>;
	executionSummary?: any;

	constructor(kind: NotebookCellKind, value: string, languageId: string) {
		this.kind = kind;
		this.value = value;
		this.languageId = languageId;
	}
}

export class NotebookData {
	cells: NotebookCellData[];
	metadata?: Record<string, any>;

	constructor(cells: NotebookCellData[]) {
		this.cells = cells;
	}
}

export class NotebookEdit {
	static insertCells(index: number, newCells: NotebookCellData[]): NotebookEdit {
		return new NotebookEdit(new NotebookRange(index, index), newCells);
	}

	static replaceCells(range: NotebookRange, newCells: NotebookCellData[]): NotebookEdit {
		return new NotebookEdit(range, newCells);
	}

	static deleteCells(range: NotebookRange): NotebookEdit {
		return new NotebookEdit(range, []);
	}

	static updateCellMetadata(index: number, newMetadata: Record<string, any>): NotebookEdit {
		const edit = new NotebookEdit(new NotebookRange(index, index), []);
		edit.newCellMetadata = newMetadata;
		return edit;
	}

	static updateNotebookMetadata(newMetadata: Record<string, any>): NotebookEdit {
		const edit = new NotebookEdit(new NotebookRange(0, 0), []);
		edit.newNotebookMetadata = newMetadata;
		return edit;
	}

	range: NotebookRange;
	newCells: NotebookCellData[];
	newCellMetadata?: Record<string, any>;
	newNotebookMetadata?: Record<string, any>;

	constructor(range: NotebookRange, newCells: NotebookCellData[]) {
		this.range = range;
		this.newCells = newCells;
	}
}
