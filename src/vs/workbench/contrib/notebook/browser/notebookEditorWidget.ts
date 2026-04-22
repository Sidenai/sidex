/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';

export class NotebookEditorWidget extends Disposable {
	constructor(..._args: any[]) {
		super();
	}

	getId(): string {
		return '';
	}

	get textModel(): any {
		return undefined;
	}

	get viewModel(): any {
		return undefined;
	}

	getSelectionViewModels(): any[] {
		return [];
	}

	hasModel(): boolean {
		return false;
	}

	getContribution<T>(_id: string): T | null {
		return null;
	}

	focus(): void {}

	getControl(): any {
		return undefined;
	}

	get uri(): URI | undefined {
		return undefined;
	}

	getCellIndex(_cell: any): number {
		return -1;
	}

	revealCellRangeInView(_range: any): void {}
	revealRangeInCenterIfOutsideViewportAsync(_cell: any, _range: any): Promise<void> {
		return Promise.resolve();
	}
}
