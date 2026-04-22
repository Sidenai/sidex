/*---------------------------------------------------------------------------------------------
 *  SideX: Stub for removed custom editor input.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

export class CustomEditorInput {
	static readonly typeId: string = 'workbench.editors.customEditor';
	readonly webview: any;
	readonly resource: any;
	readonly oldResource: any;
	readonly extension: any;
	readonly viewType: string = '';
	backupId: string | undefined;
	untitledDocumentData: VSBuffer | undefined;
	iconPath: any;
	group: number | undefined;

	readonly onWillDispose: Event<void> = Event.None;

	onMove(_handler: (newResource: URI) => void): void {
		/* stub */
	}
	getTitle(): string {
		return '';
	}
	getWebviewTitle(): string {
		return '';
	}
	resolve(): Promise<void> {
		return Promise.resolve();
	}
	dispose(): void {
		/* stub */
	}
}
