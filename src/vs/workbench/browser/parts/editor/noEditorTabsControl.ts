/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/singleeditortabscontrol.css';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorTabsControl } from './editorTabsControl.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { IEditorTitleControlDimensions } from './editorTitleControl.js';
import { IToolbarActions } from '../../../common/editor.js';

export class NoEditorTabsControl extends EditorTabsControl {
	private activeEditor: EditorInput | null = null;

	protected prepareEditorActions(_editorActions: IToolbarActions): IToolbarActions {
		return {
			primary: [],
			secondary: []
		};
	}

	openEditor(_editor: EditorInput): boolean {
		return this.handleOpenedEditors();
	}

	openEditors(_editors: EditorInput[]): boolean {
		return this.handleOpenedEditors();
	}

	private handleOpenedEditors(): boolean {
		const didChange = this.activeEditorChanged();
		this.activeEditor = this.tabsModel.activeEditor;
		return didChange;
	}

	private activeEditorChanged(): boolean {
		if (
			(!this.activeEditor && this.tabsModel.activeEditor) || // active editor changed from null => editor
			(this.activeEditor && !this.tabsModel.activeEditor) || // active editor changed from editor => null
			!this.activeEditor ||
			!this.tabsModel.isActive(this.activeEditor) // active editor changed from editorA => editorB
		) {
			return true;
		}
		return false;
	}

	beforeCloseEditor(_editor: EditorInput): void {}

	closeEditor(_editor: EditorInput): void {
		this.handleClosedEditors();
	}

	closeEditors(_editors: EditorInput[]): void {
		this.handleClosedEditors();
	}

	private handleClosedEditors(): void {
		this.activeEditor = this.tabsModel.activeEditor;
	}

	moveEditor(_editor: EditorInput, _fromIndex: number, _targetIndex: number): void {}

	pinEditor(_editor: EditorInput): void {}

	stickEditor(_editor: EditorInput): void {}

	unstickEditor(_editor: EditorInput): void {}

	setActive(_isActive: boolean): void {}

	updateEditorSelections(): void {}

	updateEditorLabel(_editor: EditorInput): void {}

	updateEditorDirty(_editor: EditorInput): void {}

	getHeight(): number {
		return 0;
	}

	layout(dimensions: IEditorTitleControlDimensions): Dimension {
		return new Dimension(dimensions.container.width, this.getHeight());
	}
}
