/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAction } from '../../../../base/common/actions.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';

export const EditorLineNumberContextMenu = MenuId.EditorLineNumberContext;

export interface IGutterActionsGenerator {
	(
		context: { lineNumber: number; editor: ICodeEditor; accessor: any; preventDefaultContextMenuItems: boolean },
		result: { push(action: IAction, group?: string): void }
	): void;
}

export class GutterActionsRegistry {
	private static readonly _generators: IGutterActionsGenerator[] = [];

	static register(generator: IGutterActionsGenerator): void {
		GutterActionsRegistry._generators.push(generator);
	}

	static registerGutterActionsGenerator(generator: IGutterActionsGenerator): void {
		GutterActionsRegistry._generators.push(generator);
	}

	static getGutterActionsGenerators(): IGutterActionsGenerator[] {
		return GutterActionsRegistry._generators;
	}
}
