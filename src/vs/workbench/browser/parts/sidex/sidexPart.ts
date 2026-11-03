/*---------------------------------------------------------------------------------------------
 *  Sidex Part — a dedicated workbench Part for the Sidex AI chat panel.
 *  Sits between the editor and the auxiliary bar in the workbench grid.
 *--------------------------------------------------------------------------------------------*/

import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ActiveSidexContext, SidexFocusContext } from '../../../common/contextkeys.js';
import {
	SIDE_BAR_BACKGROUND,
	SIDE_BAR_BORDER,
	SIDE_BAR_FOREGROUND,
	SIDE_BAR_TITLE_BORDER,
	PANEL_ACTIVE_TITLE_FOREGROUND,
	PANEL_INACTIVE_TITLE_FOREGROUND,
	PANEL_ACTIVE_TITLE_BORDER,
	PANEL_DRAG_AND_DROP_BORDER,
	ACTIVITY_BAR_BADGE_BACKGROUND,
	ACTIVITY_BAR_BADGE_FOREGROUND,
} from '../../../common/theme.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { LayoutPriority } from '../../../../base/browser/ui/splitview/splitview.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../paneCompositePart.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IPaneCompositeBarOptions } from '../paneCompositeBar.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { Extensions } from '../../panecomposite.js';

export class SidexPart extends AbstractPaneCompositePart {
	static readonly activeViewSettingsKey = 'workbench.sidex.activepanelid';
	static readonly pinnedViewsKey = 'workbench.sidex.pinnedPanels';
	static readonly placeholderViewContainersKey = 'workbench.sidex.placeholderPanels';
	static readonly viewContainersWorkspaceStateKey = 'workbench.sidex.viewContainersWorkspaceState';

	override readonly minimumWidth: number = 300;
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	get preferredHeight(): number | undefined {
		return this.layoutService.mainContainerDimension.height * 0.4;
	}

	get preferredWidth(): number | undefined {
		const activeComposite = this.getActivePaneComposite();
		if (!activeComposite) {
			return undefined;
		}
		const width = activeComposite.getOptimalWidth();
		if (typeof width !== 'number') {
			return undefined;
		}
		return Math.max(width, 300);
	}

	readonly priority = LayoutPriority.Low;

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@IMenuService menuService: IMenuService,
	) {
		super(
			Parts.SIDEX_PART,
			{
				hasTitle: false,
				trailingSeparator: false,
				borderWidth: () => (this.getColor(SIDE_BAR_BORDER) || this.getColor(contrastBorder) ? 1 : 0),
			},
			SidexPart.activeViewSettingsKey,
			ActiveSidexContext.bindTo(contextKeyService),
			SidexFocusContext.bindTo(contextKeyService),
			'sidex',
			'sidex',
			undefined,
			SIDE_BAR_TITLE_BORDER,
			ViewContainerLocation.Sidex,
			Extensions.Sidex,
			MenuId.AuxiliaryBarTitle,
			undefined,
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			viewDescriptorService,
			contextKeyService,
			extensionService,
			menuService,
		);
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());
		container.style.backgroundColor = this.getColor(SIDE_BAR_BACKGROUND) || '';
		container.style.color = this.getColor(SIDE_BAR_FOREGROUND) || '';

		const borderColor = this.getColor(SIDE_BAR_BORDER) || this.getColor(contrastBorder);
		container.style.borderLeftColor = borderColor ?? '';
		container.style.borderLeftStyle = borderColor ? 'solid' : 'none';
		container.style.borderLeftWidth = borderColor ? '1px' : '0px';
		container.style.borderRightColor = borderColor ?? '';
		container.style.borderRightStyle = borderColor ? 'solid' : 'none';
		container.style.borderRightWidth = borderColor ? '1px' : '0px';
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			partContainerClass: 'sidex',
			pinnedViewContainersKey: SidexPart.pinnedViewsKey,
			placeholderViewContainersKey: SidexPart.placeholderViewContainersKey,
			viewContainersWorkspaceStateKey: SidexPart.viewContainersWorkspaceStateKey,
			icon: false,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => this.getCompositeBarPosition() === CompositeBarPosition.BOTTOM
					? HoverPosition.ABOVE
					: HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: () => { /* no extra context menu for now */ },
			compositeSize: 0,
			iconSize: 16,
			overflowActionSize: 40,
			colors: theme => ({
				activeBackgroundColor: theme.getColor(SIDE_BAR_BACKGROUND),
				inactiveBackgroundColor: theme.getColor(SIDE_BAR_BACKGROUND),
				activeBorderBottomColor: theme.getColor(PANEL_ACTIVE_TITLE_BORDER),
				activeForegroundColor: theme.getColor(PANEL_ACTIVE_TITLE_FOREGROUND),
				inactiveForegroundColor: theme.getColor(PANEL_INACTIVE_TITLE_FOREGROUND),
				badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				dragAndDropBorder: theme.getColor(PANEL_DRAG_AND_DROP_BORDER),
			}),
			compact: true,
		};
	}

	protected shouldShowCompositeBar(): boolean {
		return false;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	override toJSON(): object {
		return {
			type: Parts.SIDEX_PART,
		};
	}
}
