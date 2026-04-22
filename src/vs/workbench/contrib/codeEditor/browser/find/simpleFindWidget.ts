/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Widget } from '../../../../../base/browser/ui/widget.js';

export interface ISimpleFindWidgetOpts {
	showCommonFindToggles?: boolean;
	checkImeCompletionState?: boolean;
	showResultCount?: boolean;
	initialWidth?: number;
	enableSash?: boolean;
	appendCaseSensitiveActionId?: string;
	appendRegexActionId?: string;
	appendWholeWordsActionId?: string;
	previousMatchActionId?: string;
	nextMatchActionId?: string;
	findInputActionId?: string;
	type?: 'Terminal' | 'Webview';
}

export abstract class SimpleFindWidget extends Widget {
	constructor(_opts?: ISimpleFindWidgetOpts, ..._services: any[]) {
		super();
	}

	protected abstract _getResultCount(
		dataChanged?: boolean
	): Promise<{ resultIndex: number; resultCount: number } | undefined>;

	getDomNode(): HTMLElement {
		return document.createElement('div');
	}

	reveal(_initialInput?: string, _animated?: boolean): void {}
	hide(_animated?: boolean): void {}
	layout(_width?: number): void {}

	protected _onInputChange(): void {}
	protected _onFocusTrackerFocus(): void {}
	protected _onFocusTrackerBlur(): void {}
	protected _onFindInputFocusTrackerFocus(): void {}
	protected _onFindInputFocusTrackerBlur(): void {}
	protected _findFirst(): void {}
	protected _findNext(_previous: boolean): void {}
}
