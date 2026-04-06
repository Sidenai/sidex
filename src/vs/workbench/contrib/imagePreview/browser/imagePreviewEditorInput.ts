/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorModel } from '../../../common/editor/editorModel.js';
import { basename } from '../../../../base/common/resources.js';
import { ImagePreviewEditor } from './imagePreviewEditor.js';

export class ImagePreviewEditorInput extends EditorInput {

	static readonly TYPE_ID = 'workbench.editors.imagePreviewInput';

	override get typeId(): string { return ImagePreviewEditorInput.TYPE_ID; }
	override get editorId(): string { return ImagePreviewEditor.ID; }
	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	constructor(readonly resource: URI) {
		super();
	}

	override getName(): string {
		return basename(this.resource);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof ImagePreviewEditorInput
			&& other.resource.toString() === this.resource.toString();
	}

	override async resolve(): Promise<EditorModel> {
		return new EditorModel();
	}
}
