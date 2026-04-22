/*---------------------------------------------------------------------------------------------
 *  SideX - A fast, native code editor
 *  Copyright (c) Siden Technologies, Inc. MIT Licensed.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import type { NotebookFindFilters } from './findFilters.js';

export class NotebookFindInputFilterButton extends Disposable {
	readonly container: HTMLElement = document.createElement('div');
	visible: boolean = false;

	constructor(
		_filters: NotebookFindFilters,
		_contextMenuService: any,
		_instantiationService: any,
		_options: any,
		_label?: string
	) {
		super();
	}

	width(): number {
		return 0;
	}

	applyStyles(_checked: boolean): void {}
}
