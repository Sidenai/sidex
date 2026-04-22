/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IEditorOptions } from '../../../../editor/common/config/editorOptions.js';

export function getSimpleEditorOptions(_configurationService?: any): IEditorOptions {
	return {
		wordWrap: 'on',
		overviewRulerLanes: 0,
		glyphMargin: false,
		lineNumbers: 'off',
		folding: false,
		selectOnLineNumbers: false,
		hideCursorInOverviewRuler: true,
		selectionHighlight: false,
		scrollbar: {
			horizontal: 'hidden',
			alwaysConsumeMouseWheel: false
		},
		lineDecorationsWidth: 0,
		overviewRulerBorder: false,
		scrollBeyondLastLine: false,
		renderLineHighlight: 'none',
		fixedOverflowWidgets: true,
		acceptSuggestionOnEnter: 'smart',
		dragAndDrop: false,
		revealHorizontalRightPadding: 5,
		minimap: {
			enabled: false
		},
		guides: {
			indentation: false
		},
		accessibilitySupport: 'off',
		cursorWidth: 1,
		padding: { top: 8, bottom: 8 }
	};
}

export function getSimpleCodeEditorWidgetOptions(): any {
	return {
		isSimpleWidget: true,
		contributions: []
	};
}

export function setupSimpleEditorSelectionStyling(_container: HTMLElement): any {
	return { dispose() {} };
}
