/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export class MenuPreventer {
	static readonly ID = 'editor.contrib.menuPreventer';

	getId(): string {
		return MenuPreventer.ID;
	}

	dispose(): void {}
}
