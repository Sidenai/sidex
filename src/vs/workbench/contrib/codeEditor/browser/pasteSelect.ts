/*---------------------------------------------------------------------------------------------
 *  SideX — Auto-select pasted text
 *  When a paste-like change is detected (>5 chars, multiple words), the inserted range
 *  is automatically selected so the user can immediately act on what they pasted.
 *  Controlled by the `editor.autoSelectOnPaste` setting.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

// Register the setting
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'editor',
	properties: {
		'editor.autoSelectOnPaste': {
			type: 'boolean',
			default: false,
			description: localize('autoSelectOnPaste', 'When enabled, automatically selects the text that was just pasted into the editor.'),
			tags: ['productivity'],
		}
	}
});

class PasteSelectContribution extends Disposable implements IEditorContribution {

	static readonly ID = 'editor.contrib.pasteSelect';

	constructor(
		private readonly _editor: ICodeEditor,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._register(this._editor.onDidChangeModelContent(e => {
			if (!this._configurationService.getValue<boolean>('editor.autoSelectOnPaste')) {
				return;
			}
			if (e.isFlush || e.changes.length === 0) {
				return;
			}
			const change = e.changes[0];
			const text = change.text;
			// Only trigger for paste-like inserts: >5 chars with multiple words
			if (text.length <= 5 || text.trim().length === 0) {
				return;
			}
			const words = text.trim().split(/\s+/);
			if (words.length < 2) {
				return;
			}
			const model = this._editor.getModel();
			if (!model) {
				return;
			}
			const range = change.range;
			const startPos = new Position(range.startLineNumber, range.startColumn);
			const startOffset = model.getOffsetAt(startPos);
			const endPos = model.getPositionAt(startOffset + text.length);
			this._editor.setSelection(new Selection(
				startPos.lineNumber, startPos.column,
				endPos.lineNumber, endPos.column
			));
		}));
	}
}

registerEditorContribution(PasteSelectContribution.ID, PasteSelectContribution, EditorContributionInstantiation.BeforeFirstInteraction);
