/*---------------------------------------------------------------------------------------------
 *  SideX: Stub for removed contributed external URI openers store.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';

export class ContributedExternalUriOpenersStore extends Disposable {
	constructor(..._args: unknown[]) {
		super();
	}
	didRegisterOpener(_id: string, _extensionId: string): void {}
	delete(_scheme: string): void {}
	getAll(): Iterable<never> {
		return [];
	}
}
