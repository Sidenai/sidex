/*---------------------------------------------------------------------------------------------
 *  SideX: Stub for removed type hierarchy types (handled by sidex-lsp).
 *--------------------------------------------------------------------------------------------*/

import { IRange } from '../../../../editor/common/core/range.js';
import { URI } from '../../../../base/common/uri.js';

export class TypeHierarchyItem {
	_sessionId: string = '';
	_itemId: string = '';
	kind: number = 0;
	name: string = '';
	detail?: string;
	uri: URI = URI.parse('');
	range: IRange = { startLineNumber: 0, startColumn: 0, endLineNumber: 0, endColumn: 0 };
	selectionRange: IRange = { startLineNumber: 0, startColumn: 0, endLineNumber: 0, endColumn: 0 };
	tags?: number[];
}

export class TypeHierarchyModel {
	static async create(_model: unknown, _position: unknown): Promise<TypeHierarchyModel | undefined> {
		return undefined;
	}
}

export const TypeHierarchyProviderRegistry: any = {
	register: () => ({ dispose: () => {} })
};
