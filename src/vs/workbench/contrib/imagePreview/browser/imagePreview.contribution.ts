/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { ImagePreviewEditor } from './imagePreviewEditor.js';
import { ImagePreviewEditorInput } from './imagePreviewEditorInput.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ImagePreviewEditor, ImagePreviewEditor.ID, localize('imagePreview', "Image Preview")),
	[new SyncDescriptor(ImagePreviewEditorInput)]
);

class ImagePreviewContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.imagePreview';

	constructor(@IEditorResolverService editorResolverService: IEditorResolverService) {
		super();
		this._register(editorResolverService.registerEditor(
			'*.{jpg,jpe,jpeg,png,bmp,gif,ico,webp,avif,svg}',
			{
				id: ImagePreviewEditor.ID,
				label: localize('imagePreview', "Image Preview"),
				priority: RegisteredEditorPriority.builtin,
			},
			{},
			{ createEditorInput: ({ resource }) => ({ editor: new ImagePreviewEditorInput(resource) }) }
		));
	}
}

registerWorkbenchContribution2(ImagePreviewContribution.ID, ImagePreviewContribution, WorkbenchPhase.BlockStartup);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'mediaPreview',
	order: 110,
	title: localize('mediaPreviewTitle', "Media Preview"),
	type: 'object',
	properties: {
		'mediaPreview.maxZoom': {
			type: 'number',
			default: 1200,
			minimum: 100,
			maximum: 10000,
			markdownDescription: localize('mediaPreview.maxZoom', "Maximum zoom level (%) for image previews. For example, `1200` = 1200%."),
			scope: ConfigurationScope.APPLICATION,
		},
		'mediaPreview.showInfo': {
			type: 'boolean',
			default: true,
			description: localize('mediaPreview.showInfo', "Show the info bar (dimensions, file size, zoom) below the image preview."),
			scope: ConfigurationScope.APPLICATION,
		},
	},
});
