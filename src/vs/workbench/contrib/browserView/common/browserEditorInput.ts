/*---------------------------------------------------------------------------------------------
 *  SideX: Stub for removed browser editor input.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';

export class BrowserEditorInput {
	static readonly ID: string = 'workbench.input.browser';
	readonly id: string = '';
	url: string = '';
	favicon: string | undefined;

	readonly onDidChangeLabel: Event<void> = Event.None;
	readonly onWillDispose: Event<void> = Event.None;

	getTitle(): string {
		return '';
	}
	resolve(): Promise<void> {
		return Promise.resolve();
	}
	dispose(): void {
		/* stub */
	}
}
