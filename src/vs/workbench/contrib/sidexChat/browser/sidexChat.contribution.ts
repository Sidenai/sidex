/*---------------------------------------------------------------------------------------------
 *  Sidex — The built-in AI panel for Sidex IDE.
 *  Registered in the AuxiliaryBar with its own status bar toggle.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import {
	Extensions as ViewExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
} from '../../../common/views.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { SidexChatViewPane } from './sidexChatView.js';
import './sidexChatService.js';

export const SIDEX_CHAT_CONTAINER_ID = 'workbench.view.sidexChat';
export const SIDEX_CHAT_VIEW_ID = 'workbench.view.sidexChat.main';

const sidexChatIcon = registerIcon('sidex-chat-icon', Codicon.commentDiscussion, nls.localize('sidexChatIcon', 'Sidex icon'));

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer(
	{
		id: SIDEX_CHAT_CONTAINER_ID,
		title: nls.localize2('sidex', 'Sidex'),
		icon: sidexChatIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SIDEX_CHAT_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		order: -100,
	},
	ViewContainerLocation.Sidex,
	{ isDefault: true, doNotRegisterOpenCommand: true }
);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[
		{
			id: SIDEX_CHAT_VIEW_ID,
			name: nls.localize2('sidex', 'Sidex'),
			containerIcon: sidexChatIcon,
			ctorDescriptor: new SyncDescriptor(SidexChatViewPane),
			canToggleVisibility: false,
			canMoveView: false,
			hideByDefault: false,
		},
	],
	viewContainer
);

// Cmd+Shift+I toggles the Sidex panel
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.toggleSidexChat',
			title: nls.localize2('toggleSidex', 'Toggle Sidex'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
				weight: KeybindingWeight.WorkbenchContrib,
			},
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		layoutService.setPartHidden(layoutService.isVisible(Parts.SIDEX_PART), Parts.SIDEX_PART);
	}
});

// Status bar toggle icon (layout-sidebar-right)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.sidexStatusBarToggle',
			title: nls.localize2('sidexStatusBarToggle', 'Toggle Sidex'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const isVisible = layoutService.isVisible(Parts.SIDEX_PART);
		layoutService.setPartHidden(isVisible, Parts.SIDEX_PART);
	}
});

// Register the status bar entries on startup
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { InlineEditController } from './inline/inlineEditController.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';

class SidexStatusBarContribution implements IWorkbenchContribution {
	static readonly ID = 'sidex.statusbar';

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		// Sidex panel toggle (far right)
		const sidexEntry = statusbarService.addEntry(
			{
				name: nls.localize('sidexToggle', 'Sidex'),
				text: this._sidexIcon(),
				ariaLabel: nls.localize('toggleSidex', 'Toggle Sidex'),
				command: 'workbench.action.sidexStatusBarToggle',
				tooltip: this._sidexTooltip(),
			},
			'sidex.toggle',
			StatusbarAlignment.RIGHT,
			-1000
		);

		// Secondary sidebar toggle (next to Sidex, for Claude Code etc.)
		const auxEntry = statusbarService.addEntry(
			{
				name: nls.localize('auxToggle', 'Secondary Sidebar'),
				text: this._auxIcon(),
				ariaLabel: nls.localize('toggleAux', 'Toggle Secondary Sidebar'),
				command: 'workbench.action.toggleAuxiliaryBar',
				tooltip: this._auxTooltip(),
			},
			'sidex.aux.toggle',
			StatusbarAlignment.RIGHT,
			-999
		);

		// Update icons when visibility changes
		const update = () => {
			sidexEntry.update({
				name: nls.localize('sidexToggle', 'Sidex'),
				text: this._sidexIcon(),
				ariaLabel: nls.localize('toggleSidex', 'Toggle Sidex'),
				command: 'workbench.action.sidexStatusBarToggle',
				tooltip: this._sidexTooltip(),
			});
			auxEntry.update({
				name: nls.localize('auxToggle', 'Secondary Sidebar'),
				text: this._auxIcon(),
				ariaLabel: nls.localize('toggleAux', 'Toggle Secondary Sidebar'),
				command: 'workbench.action.toggleAuxiliaryBar',
				tooltip: this._auxTooltip(),
			});
		};

		// Listen for layout changes
		(layoutService as any).onDidChangePartVisibility?.(() => update());
		// Fallback: poll every 500ms (some layout changes don't fire events)
		const interval = setInterval(update, 500);
		(this as unknown as { dispose?: IDisposable }).dispose = { dispose: () => clearInterval(interval) } as IDisposable;
	}

	private _sidexIcon(): string {
		return this.layoutService.isVisible(Parts.SIDEX_PART)
			? '$(sidex-panel-open)'
			: '$(sidex-panel-closed)';
	}

	private _sidexTooltip(): string {
		return this.layoutService.isVisible(Parts.SIDEX_PART) ? 'Hide Sidex' : 'Show Sidex';
	}

	private _auxIcon(): string {
		return this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)
			? '$(layout-sidebar-right)'
			: '$(layout-sidebar-right-off)';
	}

	private _auxTooltip(): string {
		return this.layoutService.isVisible(Parts.AUXILIARYBAR_PART) ? 'Hide Secondary Sidebar' : 'Show Secondary Sidebar';
	}
}

registerWorkbenchContribution2(SidexStatusBarContribution.ID, SidexStatusBarContribution, WorkbenchPhase.AfterRestored);

// Old Haiku-based inline completion — disabled in favor of Sidex Complete (sidexComplete contribution)
// class SidexInlineCompletionContribution implements IWorkbenchContribution {
// 	static readonly ID = 'sidex.inlineCompletion';
// }
// registerWorkbenchContribution2(SidexInlineCompletionContribution.ID, SidexInlineCompletionContribution, WorkbenchPhase.AfterRestored);

// --- CMD+K Inline Edit ---

// One InlineEditController per editor, lazily created
const controllerMap = new WeakMap<object, InlineEditController>();

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sidex.inlineEdit.activate',
			title: nls.localize2('sidexInlineEdit', 'Sidex: Inline Edit'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
				weight: KeybindingWeight.EditorContrib + 100,
				when: EditorContextKeys.editorTextFocus,
			},
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const codeEditorService = accessor.get(ICodeEditorService);
		const configService = accessor.get(IConfigurationService);
		const editor = codeEditorService.getFocusedCodeEditor();
		if (!editor || !isCodeEditor(editor)) {
			return;
		}

		let controller = controllerMap.get(editor);
		if (!controller) {
			controller = new InlineEditController(editor, configService);
			controllerMap.set(editor, controller);
			// Clean up when editor is disposed
			editor.onDidDispose(() => {
				controller?.dispose();
				controllerMap.delete(editor);
			});
		}

		controller.activate();
	}
});
