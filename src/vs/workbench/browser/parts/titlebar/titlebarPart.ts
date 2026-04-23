/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/titlebarpart.css';
import { localize, localize2 } from '../../../../nls.js';
import { MultiWindowParts, Part } from '../../part.js';
import { ITitleService } from '../../../services/title/browser/titleService.js';
import { getWCOTitlebarAreaRect, getZoomFactor, isWCOEnabled } from '../../../../base/browser/browser.js';
import {
	MenuBarVisibility,
	getTitleBarStyle,
	getMenuBarVisibility,
	hasCustomTitlebar,
	hasNativeTitlebar,
	DEFAULT_CUSTOM_TITLEBAR_HEIGHT,
	getWindowControlsStyle,
	WindowControlsStyle,
	TitlebarStyle,
	MenuSettings,
	hasNativeMenu
} from '../../../../platform/window/common/window.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import {
	IConfigurationService,
	IConfigurationChangeEvent
} from '../../../../platform/configuration/common/configuration.js';
import { DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import {
	TITLE_BAR_ACTIVE_BACKGROUND,
	TITLE_BAR_ACTIVE_FOREGROUND,
	TITLE_BAR_INACTIVE_FOREGROUND,
	TITLE_BAR_INACTIVE_BACKGROUND,
	TITLE_BAR_BORDER,
	WORKBENCH_BACKGROUND
} from '../../../common/theme.js';
import { isMacintosh, isWindows, isLinux, isWeb, isNative, platformLocale } from '../../../../base/common/platform.js';
import { Color } from '../../../../base/common/color.js';
import {
	EventType,
	EventHelper,
	Dimension,
	append,
	$,
	addDisposableListener,
	prepend,
	reset,
	getWindow,
	getWindowId,
	isAncestor,
	getActiveDocument,
	isHTMLElement
} from '../../../../base/browser/dom.js';
import { CustomMenubarControl } from './menubarControl.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import {
	Parts,
	IWorkbenchLayoutService,
	ActivityBarPosition,
	LayoutSettings,
	EditorActionsLocation,
	EditorTabsMode
} from '../../../services/layout/browser/layoutService.js';
import {
	createActionViewItem,
	fillInActionBarActions
} from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { Action2, IMenu, IMenuService, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { WindowTitle } from './windowTitle.js';
import { CommandCenterControl } from './commandCenterControl.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import {
	HiddenItemStrategy,
	MenuWorkbenchToolBar,
	WorkbenchToolBar
} from '../../../../platform/actions/browser/toolbar.js';
import { ACCOUNTS_ACTIVITY_ID, GLOBAL_ACTIVITY_ID } from '../../../common/activity.js';
import {
	AccountsActivityActionViewItem,
	isAccountsActionVisible,
	SimpleAccountActivityActionViewItem,
	SimpleGlobalActivityActionViewItem
} from '../globalCompositeBar.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IEditorGroupsContainer, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { ActionRunner, IAction, toAction } from '../../../../base/common/actions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	ActionsOrientation,
	IActionViewItem,
	prepareActions
} from '../../../../base/browser/ui/actionbar/actionbar.js';
import { EDITOR_CORE_NAVIGATION_COMMANDS } from '../editor/editorCommands.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { EditorPane } from '../editor/editorPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ResolvedKeybinding } from '../../../../base/common/keybindings.js';
import { EditorCommandsContextActionRunner } from '../editor/editorTabsControl.js';
import { EditorResourceAccessor, SideBySideEditor, IEditorCommandsContext, IEditorPartOptionsChangeEvent, IToolbarActions } from '../../../common/editor.js';
import { CodeWindow, mainWindow } from '../../../../base/browser/window.js';
import { ACCOUNTS_ACTIVITY_TILE_ACTION, GLOBAL_ACTIVITY_TITLE_ACTION } from './titlebarActions.js';
import { IView } from '../../../../base/browser/ui/grid/grid.js';
import { createInstantHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { safeIntl } from '../../../../base/common/date.js';
import { IsCompactTitleBarContext, TitleBarVisibleContext } from '../../../common/contextkeys.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { ISCMViewService } from '../../../contrib/scm/common/scm.js';
import { autorun, derived } from '../../../../base/common/observable.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILabelService } from '../../../../platform/label/common/label.js';

export interface ITitleVariable {
	readonly name: string;
	readonly contextKey: string;
}

export interface ITitleProperties {
	isPure?: boolean;
	isAdmin?: boolean;
	prefix?: string;
}

export interface ITitlebarPart extends IDisposable {
	/**
	 * An event when the menubar visibility changes.
	 */
	readonly onMenubarVisibilityChange: Event<boolean>;

	/**
	 * Update some environmental title properties.
	 */
	updateProperties(properties: ITitleProperties): void;

	/**
	 * Adds variables to be supported in the window title.
	 */
	registerVariables(variables: ITitleVariable[]): void;
}

export class BrowserTitleService extends MultiWindowParts<BrowserTitlebarPart> implements ITitleService {
	declare _serviceBrand: undefined;

	readonly mainPart: BrowserTitlebarPart;

	constructor(
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService
	) {
		super('workbench.titleService', themeService, storageService);

		this.mainPart = this._register(this.createMainTitlebarPart());
		this.onMenubarVisibilityChange = this.mainPart.onMenubarVisibilityChange;
		this._register(this.registerPart(this.mainPart));

		this.registerActions();
		this.registerAPICommands();
	}

	protected createMainTitlebarPart(): BrowserTitlebarPart {
		return this.instantiationService.createInstance(MainBrowserTitlebarPart);
	}

	private registerActions(): void {
		// Focus action
		const that = this;
		this._register(
			registerAction2(
				class FocusTitleBar extends Action2 {
					constructor() {
						super({
							id: `workbench.action.focusTitleBar`,
							title: localize2('focusTitleBar', 'Focus Title Bar'),
							category: Categories.View,
							f1: true,
							precondition: TitleBarVisibleContext
						});
					}

					run(): void {
						that.getPartByDocument(getActiveDocument())?.focus();
					}
				}
			)
		);
	}

	private registerAPICommands(): void {
		this._register(
			CommandsRegistry.registerCommand({
				id: 'registerWindowTitleVariable',
				handler: (accessor: ServicesAccessor, name: string, contextKey: string) => {
					this.registerVariables([{ name, contextKey }]);
				},
				metadata: {
					description: 'Registers a new title variable',
					args: [
						{ name: 'name', schema: { type: 'string' }, description: 'The name of the variable to register' },
						{
							name: 'contextKey',
							schema: { type: 'string' },
							description: 'The context key to use for the value of the variable'
						}
					]
				}
			})
		);
	}

	//#region Auxiliary Titlebar Parts

	createAuxiliaryTitlebarPart(
		container: HTMLElement,
		editorGroupsContainer: IEditorGroupsContainer,
		instantiationService: IInstantiationService
	): IAuxiliaryTitlebarPart {
		const titlebarPartContainer = $('.part.titlebar', { role: 'none' });
		titlebarPartContainer.style.position = 'relative';
		container.insertBefore(titlebarPartContainer, container.firstChild); // ensure we are first element

		const disposables = new DisposableStore();

		const titlebarPart = this.doCreateAuxiliaryTitlebarPart(
			titlebarPartContainer,
			editorGroupsContainer,
			instantiationService
		);
		disposables.add(this.registerPart(titlebarPart));

		disposables.add(
			Event.runAndSubscribe(
				titlebarPart.onDidChange,
				() => (titlebarPartContainer.style.height = `${titlebarPart.height}px`)
			)
		);
		titlebarPart.create(titlebarPartContainer);

		if (this.properties) {
			titlebarPart.updateProperties(this.properties);
		}

		if (this.variables.size) {
			titlebarPart.registerVariables(Array.from(this.variables.values()));
		}

		Event.once(titlebarPart.onWillDispose)(() => disposables.dispose());

		return titlebarPart;
	}

	protected doCreateAuxiliaryTitlebarPart(
		container: HTMLElement,
		editorGroupsContainer: IEditorGroupsContainer,
		instantiationService: IInstantiationService
	): BrowserTitlebarPart & IAuxiliaryTitlebarPart {
		return instantiationService.createInstance(
			AuxiliaryBrowserTitlebarPart,
			container,
			editorGroupsContainer,
			this.mainPart
		);
	}

	//#endregion

	//#region Service Implementation

	readonly onMenubarVisibilityChange: Event<boolean>;

	private properties: ITitleProperties | undefined = undefined;

	updateProperties(properties: ITitleProperties): void {
		this.properties = properties;

		for (const part of this.parts) {
			part.updateProperties(properties);
		}
	}

	private readonly variables = new Map<string, ITitleVariable>();

	registerVariables(variables: ITitleVariable[]): void {
		const newVariables: ITitleVariable[] = [];

		for (const variable of variables) {
			if (!this.variables.has(variable.name)) {
				this.variables.set(variable.name, variable);
				newVariables.push(variable);
			}
		}

		for (const part of this.parts) {
			part.registerVariables(newVariables);
		}
	}

	//#endregion
}

export class BrowserTitlebarPart extends Part implements ITitlebarPart {
	//#region IView

	readonly minimumWidth: number = 0;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;

	get minimumHeight(): number {
		const wcoEnabled = isWeb && isWCOEnabled();
		let value: number;
		if ((globalThis as any).__SIDEX_TAURI__) {
			value = 32;
		} else {
			value = this.isCommandCenterVisible || wcoEnabled ? DEFAULT_CUSTOM_TITLEBAR_HEIGHT : 28;
		}
		if (wcoEnabled) {
			value = Math.max(value, getWCOTitlebarAreaRect(getWindow(this.element))?.height ?? 0);
		}

		return value / (this.preventZoom ? getZoomFactor(getWindow(this.element)) : 1);
	}

	get maximumHeight(): number {
		return this.minimumHeight;
	}

	//#endregion

	//#region Events

	private _onMenubarVisibilityChange = this._register(new Emitter<boolean>());
	readonly onMenubarVisibilityChange = this._onMenubarVisibilityChange.event;

	private readonly _onWillDispose = this._register(new Emitter<void>());
	readonly onWillDispose = this._onWillDispose.event;

	//#endregion

	protected rootContainer!: HTMLElement;
	protected windowControlsContainer: HTMLElement | undefined;

	protected dragRegion: HTMLElement | undefined;
	private title!: HTMLElement;

	private leftContent!: HTMLElement;
	private centerContent!: HTMLElement;
	private rightContent!: HTMLElement;

	protected readonly customMenubar = this._register(new MutableDisposable<CustomMenubarControl>());
	protected appIcon: HTMLElement | undefined;
	private appIconBadge: HTMLElement | undefined;
	protected menubar?: HTMLElement;
	private lastLayoutDimensions: Dimension | undefined;

	private actionToolBar!: WorkbenchToolBar;
	private readonly actionToolBarDisposable = this._register(new DisposableStore());
	private readonly editorActionsChangeDisposable = this._register(new DisposableStore());
	private actionToolBarElement!: HTMLElement;
	private readonly centerAdjacentToolBarDisposable = this._register(new DisposableStore());

	private globalToolbarMenu: IMenu | undefined;
	private layoutToolbarMenu: IMenu | undefined;

	private readonly globalToolbarMenuDisposables = this._register(new DisposableStore());
	private readonly editorToolbarMenuDisposables = this._register(new DisposableStore());
	private readonly layoutToolbarMenuDisposables = this._register(new DisposableStore());
	private readonly activityToolbarDisposables = this._register(new DisposableStore());

	private readonly hoverDelegate: IHoverDelegate;

	private readonly titleDisposables = this._register(new DisposableStore());
	private titleBarStyle: TitlebarStyle;

	private isInactive: boolean = false;

	private readonly isAuxiliary: boolean;
	private isCompact = false;

	private readonly isCompactContextKey: IContextKey<boolean>;

	private readonly windowTitle: WindowTitle;

	protected readonly instantiationService: IInstantiationService;

	private projectNameElement: HTMLElement | undefined;
	private branchElement: HTMLElement | undefined;
	private breadcrumbsElement: HTMLElement | undefined;

	constructor(
		id: string,
		targetWindow: CodeWindow,
		private readonly editorGroupsContainer: IEditorGroupsContainer,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
		@IBrowserWorkbenchEnvironmentService protected readonly environmentService: IBrowserWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService protected readonly contextKeyService: IContextKeyService,
		@IHostService private readonly hostService: IHostService,
		@IEditorService private readonly editorService: IEditorService,
		@IMenuService private readonly menuService: IMenuService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILabelService private readonly labelService: ILabelService,
		@ICommandService private readonly commandService: ICommandService
	) {
		super(id, { hasTitle: false }, themeService, storageService, layoutService);

		const scopedEditorService = editorService.createScoped(editorGroupsContainer, this._store);
		this.instantiationService = this._register(
			instantiationService.createChild(new ServiceCollection([IEditorService, scopedEditorService]))
		);

		this.isAuxiliary = targetWindow.vscodeWindowId !== mainWindow.vscodeWindowId;

		this.isCompactContextKey = IsCompactTitleBarContext.bindTo(this.contextKeyService);

		this.titleBarStyle = getTitleBarStyle(this.configurationService);

		this.windowTitle = this._register(this.instantiationService.createInstance(WindowTitle, targetWindow));

		this.hoverDelegate = this._register(createInstantHoverDelegate());

		this.registerListeners(getWindowId(targetWindow));
	}

	private registerListeners(targetWindowId: number): void {
		this._register(this.hostService.onDidChangeFocus(focused => (focused ? this.onFocus() : this.onBlur())));
		this._register(
			this.hostService.onDidChangeActiveWindow(windowId =>
				windowId === targetWindowId ? this.onFocus() : this.onBlur()
			)
		);
		this._register(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationChanged(e)));
		this._register(
			this.editorGroupsContainer.onDidChangeEditorPartOptions(e => this.onEditorPartConfigurationChange(e))
		);
	}

	private onBlur(): void {
		this.isInactive = true;

		this.updateStyles();
	}

	private onFocus(): void {
		this.isInactive = false;

		this.updateStyles();
	}

	private onEditorPartConfigurationChange({ oldPartOptions, newPartOptions }: IEditorPartOptionsChangeEvent): void {
		if (
			oldPartOptions.editorActionsLocation !== newPartOptions.editorActionsLocation ||
			oldPartOptions.showTabs !== newPartOptions.showTabs
		) {
			if (hasCustomTitlebar(this.configurationService, this.titleBarStyle) && this.actionToolBar) {
				this.createActionToolBar();
				this.createActionToolBarMenus({ editorActions: true });
				this._onDidChange.fire(undefined);
			}
		}
	}

	protected onConfigurationChanged(event: IConfigurationChangeEvent): void {
		// Custom menu bar (disabled if auxiliary)
		if (!this.isAuxiliary && !hasNativeMenu(this.configurationService, this.titleBarStyle) && (!isMacintosh || isWeb)) {
			if (event.affectsConfiguration(MenuSettings.MenuBarVisibility)) {
				if (this.currentMenubarVisibility === 'compact') {
					this.uninstallMenubar();
				} else {
					this.installMenubar();
				}
			}
		}

		// Actions
		if (hasCustomTitlebar(this.configurationService, this.titleBarStyle) && this.actionToolBar) {
			const affectsLayoutControl = event.affectsConfiguration(LayoutSettings.LAYOUT_ACTIONS);
			const affectsActivityControl = event.affectsConfiguration(LayoutSettings.ACTIVITY_BAR_LOCATION);

			if (affectsLayoutControl || affectsActivityControl) {
				this.createActionToolBarMenus({ layoutActions: affectsLayoutControl, activityActions: affectsActivityControl });

				this._onDidChange.fire(undefined);
			}
		}

		// Command Center
		if (event.affectsConfiguration(LayoutSettings.COMMAND_CENTER)) {
			this.recreateTitle();
		}
	}

	private recreateTitle(): void {
		this.createTitle();

		this._onDidChange.fire(undefined);
	}

	updateOptions(options: { compact: boolean }): void {
		const oldIsCompact = this.isCompact;
		this.isCompact = options.compact;

		this.isCompactContextKey.set(this.isCompact);

		if (oldIsCompact !== this.isCompact) {
			this.recreateTitle();
			this.createActionToolBarMenus(true);
		}
	}

	protected installMenubar(): void {
		if (this.menubar) {
			return; // If the menubar is already installed, skip
		}

		this.customMenubar.value = this.instantiationService.createInstance(CustomMenubarControl);

		this.menubar = append(this.leftContent, $('div.menubar'));
		this.menubar.setAttribute('role', 'menubar');

		this._register(this.customMenubar.value.onVisibilityChange(e => this.onMenubarVisibilityChanged(e)));

		this.customMenubar.value.create(this.menubar);
	}

	private uninstallMenubar(): void {
		this.customMenubar.value = undefined;

		this.menubar?.remove();
		this.menubar = undefined;

		this.onMenubarVisibilityChanged(false);
	}

	protected onMenubarVisibilityChanged(visible: boolean): void {
		if (isWeb || isWindows || isLinux) {
			if (this.lastLayoutDimensions) {
				this.layout(this.lastLayoutDimensions.width, this.lastLayoutDimensions.height);
			}

			this._onMenubarVisibilityChange.fire(visible);
		}
	}

	updateProperties(properties: ITitleProperties): void {
		this.windowTitle.updateProperties(properties);
	}

	registerVariables(variables: ITitleVariable[]): void {
		this.windowTitle.registerVariables(variables);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.rootContainer = append(parent, $('.titlebar-container'));

		this.leftContent = append(this.rootContainer, $('.titlebar-left'));
		this.centerContent = append(this.rootContainer, $('.titlebar-center'));
		this.rightContent = append(this.rootContainer, $('.titlebar-right'));

		// App Icon (Windows, Linux)
		if ((isWindows || isLinux) && !hasNativeTitlebar(this.configurationService, this.titleBarStyle)) {
			this.appIcon = prepend(this.leftContent, $('a.window-appicon'));
		}

		// Draggable region that we can manipulate for #52522
		this.dragRegion = prepend(this.rootContainer, $('div.titlebar-drag-region'));
		if ((globalThis as any).__SIDEX_TAURI__) {
			this.dragRegion.style.setProperty('-webkit-app-region', 'no-drag');
			this.dragRegion.style.pointerEvents = 'none';

			this._register(
				addDisposableListener(this.rootContainer, EventType.MOUSE_DOWN, e => {
					const target = e.target as HTMLElement;
					if (target === this.dragRegion || target === this.rootContainer) {
						e.preventDefault();
						import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
							getCurrentWindow().startDragging();
						});
					}
				})
			);
		}

		// Menubar: install a custom menu bar depending on configuration
		if (
			!this.isAuxiliary &&
			!hasNativeMenu(this.configurationService, this.titleBarStyle) &&
			(!isMacintosh || isWeb) &&
			this.currentMenubarVisibility !== 'compact' &&
			this.currentMenubarVisibility !== 'hidden'
		) {
			this.installMenubar();
		}

		// --- Sidex Titlebar Customizations ---
		try {
			this.projectNameElement = append(this.leftContent, $('div.sidex-project-name'));
			const branchContainer = append(this.leftContent, $('div.sidex-branch-container'));
			const branchIcon = append(branchContainer, $('span.sidex-branch-icon.codicon.codicon-source-control'));
			branchIcon.setAttribute('aria-hidden', 'true');
			this.branchElement = append(branchContainer, $('span.sidex-branch-name'));
			const branchChevron = append(branchContainer, $('span.sidex-branch-chevron.codicon.codicon-chevron-down'));
			branchChevron.setAttribute('aria-hidden', 'true');

			this._register(addDisposableListener(branchContainer, EventType.CLICK, () => {
				const actions: IAction[] = [
					toAction({ id: 'sidex.git.checkout', label: 'Switch Branch...', run: () => this.commandService.executeCommand('git.checkout').catch(() => {}) }),
					toAction({ id: 'sidex.git.createBranch', label: 'Create Branch...', run: () => this.commandService.executeCommand('git.branch').catch(() => {}) }),
					toAction({ id: 'sidex.git.pull', label: 'Pull', run: () => this.commandService.executeCommand('git.pull').catch(() => {}) }),
					toAction({ id: 'sidex.git.push', label: 'Push', run: () => this.commandService.executeCommand('git.push').catch(() => {}) }),
				];
				this.contextMenuService.showContextMenu({
					getAnchor: () => branchContainer,
					getActions: () => actions,
				});
			}));

			this.updateProjectName();
			this.setupBranchTracking();

			this._register(addDisposableListener(this.projectNameElement, EventType.CLICK, () => {
				this.commandService.executeCommand('workbench.action.openRecent');
			}));

			this._register(this.workspaceContextService.onDidChangeWorkspaceName(() => this.updateProjectName()));
			this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.updateProjectName()));
			this._register(this.editorService.onDidActiveEditorChange(() => this.updateBreadcrumbs()));

			const centerBar = append(this.centerContent, $('div.sidex-center-bar'));
			const centerSearchIcon = append(centerBar, $('span.codicon.codicon-search.sidex-center-icon'));
			centerSearchIcon.setAttribute('aria-hidden', 'true');
			this.breadcrumbsElement = append(centerBar, $('div.sidex-breadcrumbs'));
			const centerPlaceholder = append(centerBar, $('span.sidex-center-placeholder'));
			centerPlaceholder.textContent = 'Search...';
			this.updateBreadcrumbs();

			this._register(addDisposableListener(centerBar, EventType.CLICK, () => {
				this.commandService.executeCommand('workbench.action.quickOpen');
			}));

			const runButton = append(this.rightContent, $('div.sidex-run-button'));
			const runIcon = append(runButton, $('span.codicon.codicon-play.sidex-run-icon'));
			runIcon.setAttribute('aria-hidden', 'true');
			this._register(addDisposableListener(runButton, EventType.CLICK, () => {
				this.commandService.executeCommand('workbench.action.debug.start');
			}));

			const settingsButton = append(this.rightContent, $('div.sidex-titlebar-action'));
			const settingsIcon = append(settingsButton, $('span.codicon.codicon-settings-gear.sidex-action-icon'));
			settingsIcon.setAttribute('aria-hidden', 'true');
			this._register(addDisposableListener(settingsButton, EventType.CLICK, () => {
				const actions: IAction[] = [
					toAction({ id: 'sidex.manage.commandPalette', label: 'Command Palette...', run: () => this.commandService.executeCommand('workbench.action.showCommands') }),
					toAction({ id: 'sidex.manage.settings', label: 'Settings', run: () => this.commandService.executeCommand('workbench.action.openSettings') }),
					toAction({ id: 'sidex.manage.keybindings', label: 'Keyboard Shortcuts', run: () => this.commandService.executeCommand('workbench.action.openGlobalKeybindings') }),
					toAction({ id: 'sidex.manage.snippets', label: 'Snippets', run: () => this.commandService.executeCommand('workbench.action.openSnippets') }),
					toAction({ id: 'sidex.manage.themes', label: 'Themes', run: () => this.commandService.executeCommand('workbench.action.selectTheme') }),
				];
				this.contextMenuService.showContextMenu({
					getAnchor: () => settingsButton,
					getActions: () => actions,
				});
			}));

			// Account / Profile button
			const accountButton = append(this.rightContent, $('div.sidex-titlebar-action.sidex-account-button'));
			const accountIcon = append(accountButton, $('span.codicon.codicon-account.sidex-action-icon'));
			accountIcon.setAttribute('aria-hidden', 'true');
			this._register(addDisposableListener(accountButton, EventType.CLICK, () => {
				this.commandService.executeCommand('workbench.action.showEditorsInActiveGroup').catch(() => {
					this.commandService.executeCommand('workbench.accounts.actions').catch(() => {});
				});
			}));
		} catch {
			// Sidex customizations failed — titlebar still works with default VSCode behavior
		}

		// Title (hidden, kept for compatibility with window title updates)
		this.title = append(this.centerContent, $('div.window-title'));
		this.title.style.display = 'none';
		this.createTitle();

		// Center-Adjacent Toolbar (e.g., update indicator)
		if (hasCustomTitlebar(this.configurationService, this.titleBarStyle)) {
			const centerAdjacentToolBarElement = append(this.rightContent, $('div.center-adjacent-toolbar-container'));
			this.centerAdjacentToolBarDisposable.add(
				this.instantiationService.createInstance(
					MenuWorkbenchToolBar,
					centerAdjacentToolBarElement,
					MenuId.TitleBarAdjacentCenter,
					{
						contextMenu: MenuId.TitleBarContext,
						hiddenItemStrategy: HiddenItemStrategy.NoHide,
						toolbarOptions: {
							primaryGroup: () => true
						},
						actionViewItemProvider: (action, options) =>
							createActionViewItem(this.instantiationService, action, options),
						hoverDelegate: this.hoverDelegate
					}
				)
			);
		}

		// Create Toolbar Actions — hidden in Sidex (we use our own minimal buttons)
		if (hasCustomTitlebar(this.configurationService, this.titleBarStyle)) {
			this.actionToolBarElement = append(this.rightContent, $('div.action-toolbar-container'));
			this.actionToolBarElement.style.display = 'none';
			this.createActionToolBar();
			this.createActionToolBarMenus();
		}

		// Window Controls Container
		if (!hasNativeTitlebar(this.configurationService, this.titleBarStyle)) {
			let primaryWindowControlsLocation = isMacintosh ? 'left' : 'right';
			if (isMacintosh && isNative) {
				const localeInfo = safeIntl.Locale(platformLocale).value;
				const textInfo = (localeInfo as { textInfo?: unknown }).textInfo;
				if (textInfo && typeof textInfo === 'object' && 'direction' in textInfo && textInfo.direction === 'rtl') {
					primaryWindowControlsLocation = 'right';
				}
			}

			if (isMacintosh && isNative && primaryWindowControlsLocation === 'left') {
				// macOS native: traffic lights handled by OS
			} else if (getWindowControlsStyle(this.configurationService) === WindowControlsStyle.HIDDEN) {
				// Linux/Windows: controls are explicitly disabled
			} else {
				this.windowControlsContainer = append(
					primaryWindowControlsLocation === 'left' ? this.leftContent : this.rightContent,
					$('div.window-controls-container')
				);
				if (isWeb) {
					append(
						primaryWindowControlsLocation === 'left' ? this.rightContent : this.leftContent,
						$('div.window-controls-container')
					);
				}

				if (isWCOEnabled()) {
					this.windowControlsContainer.classList.add('wco-enabled');
				}

				if (!isMacintosh && (globalThis as any).__SIDEX_TAURI__) {
					const minBtn = append(this.windowControlsContainer, $('div.window-icon.window-min'));
					const minIcon = append(minBtn, $('span.codicon.codicon-chrome-minimize'));
					minIcon.setAttribute('aria-hidden', 'true');

					const maxBtn = append(this.windowControlsContainer, $('div.window-icon.window-max'));
					const maxIcon = append(maxBtn, $('span.codicon.codicon-chrome-maximize'));
					maxIcon.setAttribute('aria-hidden', 'true');

					const closeBtn = append(this.windowControlsContainer, $('div.window-icon.window-close'));
					const closeIcon = append(closeBtn, $('span.codicon.codicon-chrome-close'));
					closeIcon.setAttribute('aria-hidden', 'true');

					import('@tauri-apps/api/window')
						.then(({ getCurrentWindow }) => {
							const win = getCurrentWindow();

							this._register(addDisposableListener(minBtn, EventType.CLICK, () => win.minimize()));
							this._register(addDisposableListener(maxBtn, EventType.CLICK, () => win.toggleMaximize()));
							this._register(addDisposableListener(closeBtn, EventType.CLICK, () => win.close()));

							const updateMaxIcon = async () => {
								const maximized = await win.isMaximized();
								if (maximized) {
									maxIcon.classList.remove('codicon-chrome-maximize');
									maxIcon.classList.add('codicon-chrome-restore');
								} else {
									maxIcon.classList.remove('codicon-chrome-restore');
									maxIcon.classList.add('codicon-chrome-maximize');
								}
							};

							updateMaxIcon();
							win
								.onResized(() => updateMaxIcon())
								.then(unlisten => {
									this._register({ dispose: () => unlisten() });
								});
						})
						.catch(() => {
							/* not in Tauri context */
						});
				}
			}
		}

		// Context menu over title bar
		{
			this._register(
				addDisposableListener(this.rootContainer, EventType.CONTEXT_MENU, e => {
					EventHelper.stop(e);

					let targetMenu: MenuId;
					if (isMacintosh && isHTMLElement(e.target) && isAncestor(e.target, this.title)) {
						targetMenu = MenuId.TitleBarTitleContext;
					} else {
						targetMenu = MenuId.TitleBarContext;
					}

					this.onContextMenu(e, targetMenu);
				})
			);

			if (isMacintosh) {
				this._register(
					addDisposableListener(
						this.title,
						EventType.MOUSE_DOWN,
						e => {
							if (e.metaKey) {
								EventHelper.stop(e, true);
								this.onContextMenu(e, MenuId.TitleBarTitleContext);
							}
						},
						true
					)
				);
			}
		}

		this.updateStyles();

		return this.element;
	}

	private updateProjectName(): void {
		try {
			if (!this.projectNameElement) { return; }
			const workspace = this.workspaceContextService.getWorkspace();
			const name = this.labelService.getWorkspaceLabel(workspace);
			this.projectNameElement.textContent = name || 'SideX';
		} catch { /* ignore during workspace transitions */ }
	}

	private setupBranchTracking(): void {
		try {
			if (!this.scmViewService || this.isAuxiliary) {
				return;
			}
			const branchName = derived(reader => {
				try {
					const activeRepo = this.scmViewService?.activeRepository?.read(reader);
					const historyProvider = activeRepo?.repository?.provider?.historyProvider?.read(reader);
					const historyItemRef = historyProvider?.historyItemRef?.read(reader);
					return historyItemRef?.name;
				} catch {
					return undefined;
				}
			});

			this._register(autorun(reader => {
				try {
					const name = branchName.read(reader);
					this.updateBranchDisplay(name);
				} catch { /* ignore */ }
			}));
		} catch { /* SCM service may not be available */ }
	}

	private updateBranchDisplay(branchName: string | undefined): void {
		if (!this.branchElement) {
			return;
		}
		const container = this.branchElement.parentElement;
		if (!container) {
			return;
		}
		if (branchName) {
			container.style.display = '';
			this.branchElement.textContent = branchName;
		} else {
			container.style.display = 'none';
			this.branchElement.textContent = '';
		}
	}

	private updateBreadcrumbs(): void {
		try {
		if (!this.breadcrumbsElement) {
			return;
		}

		const centerBar = this.breadcrumbsElement.parentElement;
		const placeholder = centerBar?.querySelector('.sidex-center-placeholder') as HTMLElement | null;

		const editor = this.editorService.activeEditor;
		const resource = editor ? EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY }) : undefined;

		if (!resource || !resource.path) {
			this.breadcrumbsElement.textContent = '';
			this.breadcrumbsElement.style.display = 'none';
			if (placeholder) { placeholder.style.display = ''; }
			return;
		}

		this.breadcrumbsElement.style.display = '';
		if (placeholder) { placeholder.style.display = 'none'; }

		let relativePath = this.labelService.getUriLabel(resource, { relative: true });
		if (!relativePath) {
			relativePath = resource.path;
		}

		const segments = relativePath.split('/').filter(s => s.length > 0);
		const fragment = document.createDocumentFragment();

		for (let i = 0; i < segments.length; i++) {
			const span = document.createElement('span');
			span.classList.add('sidex-breadcrumb-segment');
			const isLast = i === segments.length - 1;
			if (isLast) {
				span.classList.add('sidex-breadcrumb-file');
			}
			span.textContent = segments[i];
			fragment.appendChild(span);

			if (!isLast) {
				const sep = document.createElement('span');
				sep.classList.add('sidex-breadcrumb-sep');
				sep.textContent = '›';
				fragment.appendChild(sep);
			}
		}

		reset(this.breadcrumbsElement, fragment);
		} catch { /* ignore during workspace transitions */ }
	}

	private createTitle(): void {
		this.titleDisposables.clear();

		const isShowingTitleInNativeTitlebar = hasNativeTitlebar(this.configurationService, this.titleBarStyle);

		// Text Title
		if (!this.isCommandCenterVisible) {
			if (!isShowingTitleInNativeTitlebar) {
				this.title.textContent = this.windowTitle.value;
				this.titleDisposables.add(
					this.windowTitle.onDidChange(() => {
						this.title.textContent = this.windowTitle.value;
						if (this.lastLayoutDimensions) {
							this.updateLayout(this.lastLayoutDimensions); // layout menubar and other renderings in the titlebar
						}
					})
				);
			} else {
				reset(this.title);
			}
		}

		// Menu Title
		else {
			const commandCenter = this.instantiationService.createInstance(
				CommandCenterControl,
				this.windowTitle,
				this.hoverDelegate
			);
			reset(this.title, commandCenter.element);
			this.titleDisposables.add(commandCenter);
		}
	}

	private actionViewItemProvider(action: IAction, options: IBaseActionViewItemOptions): IActionViewItem | undefined {
		// --- Activity Actions
		if (!this.isAuxiliary) {
			if (action.id === GLOBAL_ACTIVITY_ID) {
				return this.instantiationService.createInstance(
					SimpleGlobalActivityActionViewItem,
					{ position: () => HoverPosition.BELOW },
					options
				);
			}
			if (action.id === ACCOUNTS_ACTIVITY_ID) {
				return this.instantiationService.createInstance(
					SimpleAccountActivityActionViewItem,
					{ position: () => HoverPosition.BELOW },
					options
				);
			}
		}

		// --- Editor Actions
		const activeEditorPane = this.editorGroupsContainer.activeGroup?.activeEditorPane;
		if (activeEditorPane && activeEditorPane instanceof EditorPane) {
			const result = activeEditorPane.getActionViewItem(action, options);

			if (result) {
				return result;
			}
		}

		// Check extensions
		return createActionViewItem(this.instantiationService, action, { ...options, menuAsChild: false });
	}

	private getKeybinding(action: IAction): ResolvedKeybinding | undefined {
		const editorPaneAwareContextKeyService =
			this.editorGroupsContainer.activeGroup?.activeEditorPane?.scopedContextKeyService ?? this.contextKeyService;

		return this.keybindingService.lookupKeybinding(action.id, editorPaneAwareContextKeyService);
	}

	private createActionToolBar(): void {
		// Creates the action tool bar. Depends on the configuration of the title bar menus
		// Requires to be recreated whenever editor actions enablement changes

		this.actionToolBarDisposable.clear();

		this.actionToolBar = this.actionToolBarDisposable.add(
			this.instantiationService.createInstance(WorkbenchToolBar, this.actionToolBarElement, {
				contextMenu: MenuId.TitleBarContext,
				orientation: ActionsOrientation.HORIZONTAL,
				ariaLabel: localize('ariaLabelTitleActions', 'Title actions'),
				getKeyBinding: action => this.getKeybinding(action),
				overflowBehavior: {
					maxItems: 9,
					exempted: [ACCOUNTS_ACTIVITY_ID, GLOBAL_ACTIVITY_ID, ...EDITOR_CORE_NAVIGATION_COMMANDS]
				},
				anchorAlignmentProvider: () => AnchorAlignment.RIGHT,
				telemetrySource: 'titlePart',
				highlightToggledItems: this.editorActionsEnabled || this.isAuxiliary, // Only show toggled state for editor actions or auxiliary title bars
				actionViewItemProvider: (action, options) => this.actionViewItemProvider(action, options),
				hoverDelegate: this.hoverDelegate
			})
		);

		if (this.editorActionsEnabled) {
			this.actionToolBarDisposable.add(
				this.editorGroupsContainer.onDidChangeActiveGroup(() => this.createActionToolBarMenus({ editorActions: true }))
			);
		}
	}

	private createActionToolBarMenus(
		update:
			| true
			| { editorActions?: boolean; layoutActions?: boolean; globalActions?: boolean; activityActions?: boolean } = true
	): void {
		if (update === true) {
			update = { editorActions: true, layoutActions: true, globalActions: true, activityActions: true };
		}

		const updateToolBarActions = () => {
			const actions: IToolbarActions = { primary: [], secondary: [] };

			// --- Editor Actions
			if (this.editorActionsEnabled) {
				this.editorActionsChangeDisposable.clear();

				const activeGroup = this.editorGroupsContainer.activeGroup;
				if (activeGroup) {
					const editorActions = activeGroup.createEditorActions(
						this.editorActionsChangeDisposable,
						this.isAuxiliary && this.isCompact ? MenuId.CompactWindowEditorTitle : MenuId.EditorTitle
					);

					actions.primary.push(...editorActions.actions.primary);
					actions.secondary.push(...editorActions.actions.secondary);

					this.editorActionsChangeDisposable.add(editorActions.onDidChange(() => updateToolBarActions()));
				}
			}

			// --- Layout Actions
			if (this.layoutToolbarMenu) {
				fillInActionBarActions(
					this.layoutToolbarMenu.getActions(),
					actions,
					() => !this.editorActionsEnabled || this.isCompact // layout actions move to "..." if editor actions are enabled unless compact
				);
			}

			// --- Global Actions (after layout so e.g. notification bell appears to the right of layout controls)
			if (this.globalToolbarMenu) {
				fillInActionBarActions(this.globalToolbarMenu.getActions(), actions);
			}

			// --- Activity Actions (always at the end)
			if (this.activityActionsEnabled) {
				if (isAccountsActionVisible(this.storageService)) {
					actions.primary.push(ACCOUNTS_ACTIVITY_TILE_ACTION);
				}

				actions.primary.push(GLOBAL_ACTIVITY_TITLE_ACTION);
			}

			this.actionToolBar.setActions(prepareActions(actions.primary), prepareActions(actions.secondary));
		};

		// Create/Update the menus which should be in the title tool bar

		if (update.editorActions) {
			this.editorToolbarMenuDisposables.clear();

			// The editor toolbar menu is handled by the editor group so we do not need to manage it here.
			// However, depending on the active editor, we need to update the context and action runner of the toolbar menu.
			if (this.editorActionsEnabled && this.editorGroupsContainer.activeGroup?.activeEditor) {
				const context: IEditorCommandsContext = { groupId: this.editorGroupsContainer.activeGroup.id };

				this.actionToolBar.actionRunner = this.editorToolbarMenuDisposables.add(
					new EditorCommandsContextActionRunner(context)
				);
				this.actionToolBar.context = context;
			} else {
				this.actionToolBar.actionRunner = this.editorToolbarMenuDisposables.add(new ActionRunner());
				this.actionToolBar.context = undefined;
			}
		}

		if (update.layoutActions) {
			this.layoutToolbarMenuDisposables.clear();

			if (this.layoutControlEnabled) {
				this.layoutToolbarMenu = this.menuService.createMenu(MenuId.LayoutControlMenu, this.contextKeyService);

				this.layoutToolbarMenuDisposables.add(this.layoutToolbarMenu);
				this.layoutToolbarMenuDisposables.add(this.layoutToolbarMenu.onDidChange(() => updateToolBarActions()));
			} else {
				this.layoutToolbarMenu = undefined;
			}
		}

		if (update.globalActions) {
			this.globalToolbarMenuDisposables.clear();

			if (this.globalActionsEnabled) {
				this.globalToolbarMenu = this.menuService.createMenu(MenuId.TitleBar, this.contextKeyService);

				this.globalToolbarMenuDisposables.add(this.globalToolbarMenu);
				this.globalToolbarMenuDisposables.add(this.globalToolbarMenu.onDidChange(() => updateToolBarActions()));
			} else {
				this.globalToolbarMenu = undefined;
			}
		}

		if (update.activityActions) {
			this.activityToolbarDisposables.clear();
			if (this.activityActionsEnabled) {
				this.activityToolbarDisposables.add(
					this.storageService.onDidChangeValue(
						StorageScope.PROFILE,
						AccountsActivityActionViewItem.ACCOUNTS_VISIBILITY_PREFERENCE_KEY,
						this._store
					)(() => updateToolBarActions())
				);
			}
		}

		updateToolBarActions();
	}

	override updateStyles(): void {
		super.updateStyles();

		// Part container
		if (this.element) {
			this.element.classList.remove('inactive');

			const titleBackground =
				this.getColor(TITLE_BAR_ACTIVE_BACKGROUND, (color, theme) => {
					return color.isOpaque() ? color : color.makeOpaque(WORKBENCH_BACKGROUND(theme));
				}) || '';
			this.element.style.backgroundColor = titleBackground;

			const titleForeground = this.getColor(TITLE_BAR_ACTIVE_FOREGROUND);
			this.element.style.color = titleForeground || '';

			const titleBorder = this.getColor(TITLE_BAR_BORDER);
			this.element.style.borderBottom = titleBorder ? `1px solid ${titleBorder}` : '';
		}
	}

	protected onContextMenu(e: MouseEvent, menuId: MenuId): void {
		const event = new StandardMouseEvent(getWindow(this.element), e);

		// Show it
		this.contextMenuService.showContextMenu({
			getAnchor: () => event,
			menuId,
			contextKeyService: this.contextKeyService,
			domForShadowRoot: isMacintosh && isNative ? event.target : undefined
		});
	}

	protected get currentMenubarVisibility(): MenuBarVisibility {
		if (this.isAuxiliary) {
			return 'hidden';
		}

		return getMenuBarVisibility(this.configurationService);
	}

	private get layoutControlEnabled(): boolean {
		return this.configurationService.getValue<boolean>(LayoutSettings.LAYOUT_ACTIONS) !== false;
	}

	protected get isCommandCenterVisible() {
		// Sidex: command center is hidden by default (the search bar is removed from the titlebar)
		if ((globalThis as any).__SIDEX_TAURI__) {
			return false;
		}
		return !this.isCompact && this.configurationService.getValue<boolean>(LayoutSettings.COMMAND_CENTER) !== false;
	}

	private get editorActionsEnabled(): boolean {
		return (
			this.editorGroupsContainer.partOptions.editorActionsLocation === EditorActionsLocation.TITLEBAR ||
			(this.editorGroupsContainer.partOptions.editorActionsLocation === EditorActionsLocation.DEFAULT &&
				this.editorGroupsContainer.partOptions.showTabs === EditorTabsMode.NONE)
		);
	}

	private get activityActionsEnabled(): boolean {
		const activityBarPosition = this.configurationService.getValue<ActivityBarPosition>(
			LayoutSettings.ACTIVITY_BAR_LOCATION
		);
		return (
			!this.isCompact &&
			!this.isAuxiliary &&
			(activityBarPosition === ActivityBarPosition.TOP || activityBarPosition === ActivityBarPosition.BOTTOM)
		);
	}

	private get globalActionsEnabled(): boolean {
		return !this.isCompact;
	}

	get hasZoomableElements(): boolean {
		const hasMenubar = !(
			this.currentMenubarVisibility === 'hidden' ||
			this.currentMenubarVisibility === 'compact' ||
			(!isWeb && isMacintosh)
		);
		const hasCommandCenter = this.isCommandCenterVisible;
		const hasToolBarActions =
			this.globalActionsEnabled ||
			this.layoutControlEnabled ||
			this.editorActionsEnabled ||
			this.activityActionsEnabled;
		return hasMenubar || hasCommandCenter || hasToolBarActions;
	}

	get preventZoom(): boolean {
		// Prevent zooming behavior if any of the following conditions are met:
		// 1. Shrinking below the window control size (zoom < 1)
		// 2. No custom items are present in the title bar

		return getZoomFactor(getWindow(this.element)) < 1 || !this.hasZoomableElements;
	}

	override layout(width: number, height: number): void {
		this.updateLayout(new Dimension(width, height));

		super.layoutContents(width, height);
	}

	private updateLayout(dimension: Dimension): void {
		this.lastLayoutDimensions = dimension;

		if (!hasCustomTitlebar(this.configurationService, this.titleBarStyle)) {
			return;
		}

		const zoomFactor = getZoomFactor(getWindow(this.element));

		this.element.style.setProperty('--zoom-factor', zoomFactor.toString());
		this.rootContainer.classList.toggle('counter-zoom', this.preventZoom);

		if (this.customMenubar.value) {
			const menubarDimension = new Dimension(0, dimension.height);
			this.customMenubar.value.layout(menubarDimension);
		}

		// Sidex always has center content (breadcrumbs)
		this.rootContainer.classList.add('has-center');
	}

	focus(): void {
		if (this.customMenubar.value) {
			this.customMenubar.value.toggleFocus();
		} else {
			(this.element.querySelector('[tabindex]:not([tabindex="-1"])') as HTMLElement | null)?.focus();
		}
	}

	toJSON(): object {
		return {
			type: Parts.TITLEBAR_PART
		};
	}

	override dispose(): void {
		this._onWillDispose.fire();

		super.dispose();
	}
}

export class MainBrowserTitlebarPart extends BrowserTitlebarPart {
	constructor(
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ISCMViewService scmViewService: ISCMViewService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ILabelService labelService: ILabelService,
		@ICommandService commandService: ICommandService
	) {
		super(
			Parts.TITLEBAR_PART,
			mainWindow,
			editorGroupService.mainPart,
			contextMenuService,
			configurationService,
			environmentService,
			instantiationService,
			themeService,
			storageService,
			layoutService,
			contextKeyService,
			hostService,
			editorService,
			menuService,
			keybindingService,
			scmViewService,
			workspaceContextService,
			labelService,
			commandService
		);
	}
}

export interface IAuxiliaryTitlebarPart extends ITitlebarPart, IView {
	readonly container: HTMLElement;
	readonly height: number;

	updateOptions(options: { compact: boolean }): void;
}

export class AuxiliaryBrowserTitlebarPart extends BrowserTitlebarPart implements IAuxiliaryTitlebarPart {
	private static COUNTER = 1;

	get height() {
		return this.minimumHeight;
	}

	constructor(
		readonly container: HTMLElement,
		editorGroupsContainer: IEditorGroupsContainer,
		private readonly mainTitlebar: BrowserTitlebarPart,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ISCMViewService scmViewService: ISCMViewService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ILabelService labelService: ILabelService,
		@ICommandService commandService: ICommandService
	) {
		const id = AuxiliaryBrowserTitlebarPart.COUNTER++;
		super(
			`workbench.parts.auxiliaryTitle.${id}`,
			getWindow(container),
			editorGroupsContainer,
			contextMenuService,
			configurationService,
			environmentService,
			instantiationService,
			themeService,
			storageService,
			layoutService,
			contextKeyService,
			hostService,
			editorService,
			menuService,
			keybindingService,
			scmViewService,
			workspaceContextService,
			labelService,
			commandService
		);
	}

	override get preventZoom(): boolean {
		// Prevent zooming behavior if any of the following conditions are met:
		// 1. Shrinking below the window control size (zoom < 1)
		// 2. No custom items are present in the main title bar
		// The auxiliary title bar never contains any zoomable items itself,
		// but we want to match the behavior of the main title bar.

		return getZoomFactor(getWindow(this.element)) < 1 || !this.mainTitlebar.hasZoomableElements;
	}
}
