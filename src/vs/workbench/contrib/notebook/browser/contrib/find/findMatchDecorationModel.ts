/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';

export class FindMatchDecorationModel extends Disposable {
	constructor(..._args: any[]) {
		super();
	}

	get currentMatchDecorations(): any {
		return null;
	}

	setAllFindMatchesDecorations(_cellFindMatches: any[]): void {}
	setCurrentFindMatchDecoration(_cellIndex: number, _matchIndex: number): void {}
	clearCurrentFindMatchDecoration(): void {}
	highlightCurrentFindMatchDecoration(_cellIndex: number, _matchIndex: number): void {}
}
