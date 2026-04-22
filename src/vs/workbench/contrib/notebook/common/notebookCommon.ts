/*---------------------------------------------------------------------------------------------
 *  SideX: Stub for removed notebook contribution.
 *  Provides type-only exports consumed by the extension host API layer.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

export const enum CellKind {
	Markup = 1,
	Code = 2
}

export const enum CellEditType {
	Replace = 1,
	Output = 2,
	Metadata = 3,
	CellLanguage = 4,
	DocumentMetadata = 5,
	Move = 6,
	OutputItems = 7,
	PartialMetadata = 8,
	PartialInternalMetadata = 9
}

export const enum CellStatusbarAlignment {
	Left = 1,
	Right = 2
}

export const enum NotebookCellsChangeType {
	ModelChange = 1,
	Move = 2,
	Output = 3,
	OutputItem = 4,
	ChangeCellLanguage = 5,
	ChangeCellMime = 6,
	ChangeCellMetadata = 7,
	ChangeCellInternalMetadata = 8,
	ChangeCellContent = 9,
	ChangeDocumentMetadata = 10
}

export interface NotebookDocumentMetadata {
	[key: string]: unknown;
}

export interface NotebookCellMetadata {
	[key: string]: unknown;
}

export interface NotebookCellInternalMetadata {
	executionOrder?: number;
	lastRunSuccess?: boolean;
	runStartTime?: number;
	runStartTimeAdjustment?: number;
	runEndTime?: number;
}

export interface INotebookCellStatusBarItem {
	readonly text: string;
	readonly alignment: CellStatusbarAlignment;
	readonly command?: string | { id: string; title: string; arguments?: unknown[] };
	readonly tooltip?: string;
	readonly priority?: number;
	readonly accessibilityInformation?: { label: string; role?: string };
	readonly opacity?: string;
}

export interface NotebookExtensionDescription {
	readonly id: string;
	readonly location: URI | undefined;
}

export interface TransientOptions {
	readonly transientOutputs: boolean;
	readonly transientCellMetadata: TransientCellMetadata;
	readonly transientDocumentMetadata: TransientDocumentMetadata;
	readonly cellContentMetadata: TransientCellMetadata;
}

export type TransientCellMetadata = { [key: string]: boolean | undefined };
export type TransientDocumentMetadata = { [key: string]: boolean | undefined };

export interface INotebookContributionData {
	extension?: string;
	providerDisplayName: string;
	displayName: string;
	filenamePattern: readonly (string | { include: string; exclude: string })[];
	exclusive: boolean;
}

export interface INotebookKernelSourceAction {
	readonly label: string;
	readonly description?: string;
	readonly detail?: string;
	readonly command?: string | { id: string; title: string; arguments?: unknown[] };
	readonly documentation?: URI | string;
}

export interface ICellMetadataEdit {
	editType: CellEditType.Metadata;
	index: number;
	metadata: NotebookCellMetadata;
}

export interface IDocumentMetadataEdit {
	editType: CellEditType.DocumentMetadata;
	metadata: NotebookDocumentMetadata;
}

export interface NotebookCellTextModelSplice<T> {
	readonly start: number;
	readonly deleteCount: number;
	readonly newItems: T[];
}

export interface NotebookCellsChangeLanguageEvent {
	readonly kind: NotebookCellsChangeType.ChangeCellLanguage;
	readonly index: number;
	readonly language: string;
}

export interface NotebookCellsChangeMimeEvent {
	readonly kind: NotebookCellsChangeType.ChangeCellMime;
	readonly index: number;
	readonly mime: string;
}

export interface NotebookCellsChangeMetadataEvent {
	readonly kind: NotebookCellsChangeType.ChangeCellMetadata;
	readonly index: number;
	readonly metadata: NotebookCellMetadata;
}

export interface NotebookCellsChangeInternalMetadataEvent {
	readonly kind: NotebookCellsChangeType.ChangeCellInternalMetadata;
	readonly index: number;
	readonly internalMetadata: NotebookCellInternalMetadata;
}

export interface NotebookCellContentChangeEvent {
	readonly kind: NotebookCellsChangeType.ChangeCellContent;
	readonly index: number;
}

export interface IWorkspaceNotebookCellEdit {
	metadata?: unknown;
	resource: URI;
	notebookVersionId: number | undefined;
	cellEdit:
		| ICellMetadataEdit
		| IDocumentMetadataEdit
		| { editType: CellEditType.Replace; index: number; count: number; cells: unknown[] };
}

export type NotebookPriorityInfo = { filenamePattern?: string };

export namespace CellUri {
	export function generate(notebook: URI, handle: number): URI {
		return notebook.with({ scheme: 'vscode-notebook-cell', fragment: `${handle}` });
	}
	export function parse(cell: URI): { notebook: URI; handle: number } | undefined {
		if (cell.scheme !== 'vscode-notebook-cell') {
			return undefined;
		}
		const match = /^(\d+)$/.exec(cell.fragment);
		if (!match) {
			return undefined;
		}
		return { notebook: cell.with({ scheme: cell.query || 'file', fragment: '' }), handle: parseInt(match[1], 10) };
	}
}

export interface IResolvedNotebookEditorModel {
	readonly uri: URI;
	readonly notebook: unknown;
}

export interface INotebookExclusiveDocumentFilter {
	include?: string;
	exclude?: string;
}

export const enum NotebookFindScopeType {
	None = 0,
	Cells = 1,
	Text = 2
}

export const enum NotebookSetting {
	displayOrder = 'notebook.displayOrder',
	cellToolbarLocation = 'notebook.cellToolbarLocation',
	showCellStatusBar = 'notebook.showCellStatusBar',
	compactView = 'notebook.compactView',
	focusIndicator = 'notebook.cellFocusIndicator',
	insertToolbarLocation = 'notebook.insertToolbarLocation',
	globalToolbar = 'notebook.globalToolbar',
	consolidatedOutputButton = 'notebook.consolidatedOutputButton',
	showFoldingControls = 'notebook.showFoldingControls',
	dragAndDropEnabled = 'notebook.dragAndDropEnabled',
	formatOnSave = 'notebook.formatOnSave.enabled',
	formatOnCellExecution = 'notebook.formatOnCellExecution',
	codeActionsOnSave = 'notebook.codeActionsOnSave',
	outputWordWrap = 'notebook.output.wordWrap',
	outputScrolling = 'notebook.output.scrolling',
	outputFontSize = 'notebook.output.fontSize',
	outputFontFamily = 'notebook.output.fontFamily',
	outputLineHeight = 'notebook.output.lineHeight',
	textOutputLineLimit = 'notebook.output.textLineLimit',
	cellChat = 'notebook.experimental.cellChat'
}

export const INTERACTIVE_WINDOW_EDITOR_ID = 'interactive';
export const REPL_EDITOR_ID = 'repl';

export const enum SelectionStateType {
	Handle = 0,
	Index = 1
}

export interface ISelectionState {
	kind: SelectionStateType;
	focus: { start: number; end: number };
	selections: { start: number; end: number }[];
}

export interface ICellPartialMetadataEdit {
	editType: CellEditType.PartialMetadata;
	index: number;
	metadata: Record<string, unknown>;
}

export interface ICellReplaceEdit {
	editType: CellEditType.Replace;
	index: number;
	count: number;
	cells: unknown[];
}
