/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import {
	IColorTheme,
	IThemeService,
	IFileIconTheme,
	IProductIconTheme
} from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme' /* id kept for compatibility reasons */,
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export namespace ThemeSettingDefaults {
	export const COLOR_THEME_DARK = 'Dark Modern';
	export const COLOR_THEME_LIGHT = 'Light Modern';
	export const COLOR_THEME_HC_DARK = 'Default High Contrast';
	export const COLOR_THEME_HC_LIGHT = 'Default High Contrast Light';

	export const FILE_ICON_THEME = 'vs-seti';
	export const PRODUCT_ICON_THEME = 'Default';
}

/**
 * Migrates legacy theme settings IDs to their current equivalents.
 * Theme IDs were simplified: "Default" prefix was removed from built-in themes,
 * and "Experimental" prefix was replaced when VS Code themes became GA.
 */
export function migrateThemeSettingsId(settingsId: string): string {
	switch (settingsId) {
		case 'SideX Monochrome Dark':
			return 'Dark Modern';
		case 'Light 2026':
			return 'Light Modern';
		case 'Default Dark Modern':
			return 'Dark Modern';
		case 'Default Light Modern':
			return 'Light Modern';
		case 'Default Dark+':
			return 'Dark+';
		case 'Default Light+':
			return 'Light+';
		case 'Experimental Dark':
		case 'VS Code Dark':
			return ThemeSettingDefaults.COLOR_THEME_DARK;
		case 'Experimental Light':
		case 'VS Code Light':
			return ThemeSettingDefaults.COLOR_THEME_LIGHT;
	}
	return settingsId;
}

export const COLOR_THEME_SIDEX_MONO_INITIAL_COLORS: Record<string, string> = {
	'actionBar.toggledBackground': '#252525',
	'activityBar.activeBorder': '#d0d0d0',
	'activityBar.background': '#0a0a0a',
	'activityBar.border': '#141414',
	'activityBar.foreground': '#c8c8c8',
	'activityBar.inactiveForeground': '#505050',
	'activityBarBadge.background': '#b0b0b0',
	'activityBarBadge.foreground': '#0a0a0a',
	'badge.background': '#2a2a2a',
	'badge.foreground': '#c0c0c0',
	'button.background': '#d0d0d0',
	'button.border': '#ffffff08',
	'button.foreground': '#0a0a0a',
	'button.hoverBackground': '#b8b8b8',
	'button.secondaryBackground': '#252525',
	'button.secondaryForeground': '#b0b0b0',
	'button.secondaryHoverBackground': '#303030',
	'checkbox.background': '#161616',
	'checkbox.border': '#303030',
	'debugToolBar.background': '#0e0e0e',
	descriptionForeground: '#606060',
	'dropdown.background': '#161616',
	'dropdown.border': '#252525',
	'dropdown.foreground': '#c0c0c0',
	'dropdown.listBackground': '#141414',
	'editor.background': '#111111',
	'editor.findMatchBackground': '#3a3a3a',
	'editor.foreground': '#c8c8c8',
	'editor.inactiveSelectionBackground': '#252525',
	'editor.selectionHighlightBackground': '#ffffff12',
	'editorCursor.foreground': '#d0d0d0',
	'editorGroup.border': '#161616',
	'editorGroupHeader.tabsBackground': '#0a0a0a',
	'editorGroupHeader.tabsBorder': '#141414',
	'editorGutter.addedBackground': '#606060',
	'editorGutter.deletedBackground': '#808080',
	'editorGutter.modifiedBackground': '#707070',
	'editorIndentGuide.activeBackground1': '#404040',
	'editorIndentGuide.background1': '#1e1e1e',
	'editorLineNumber.activeForeground': '#909090',
	'editorLineNumber.foreground': '#303030',
	'editorOverviewRuler.border': '#0e0e0e',
	'editorWidget.background': '#141414',
	errorForeground: '#b0b0b0',
	focusBorder: '#404040',
	foreground: '#b0b0b0',
	'icon.foreground': '#808080',
	'input.background': '#161616',
	'input.border': '#252525',
	'input.foreground': '#c0c0c0',
	'input.placeholderForeground': '#505050',
	'inputOption.activeBackground': '#303030',
	'inputOption.activeBorder': '#707070',
	'keybindingLabel.foreground': '#b0b0b0',
	'list.activeSelectionBackground': '#1e1e1e',
	'list.activeSelectionForeground': '#e0e0e0',
	'list.activeSelectionIconForeground': '#e0e0e0',
	'list.dropBackground': '#1e1e1e',
	'list.hoverBackground': '#161616',
	'menu.background': '#1a1a1a',
	'menu.border': '#2a2a2a',
	'menu.foreground': '#c0c0c0',
	'menu.selectionBackground': '#2a2a2a',
	'menu.separatorBackground': '#2a2a2a',
	'notificationCenterHeader.background': '#141414',
	'notificationCenterHeader.foreground': '#b0b0b0',
	'notifications.background': '#141414',
	'notifications.border': '#1e1e1e',
	'notifications.foreground': '#b0b0b0',
	'panel.background': '#0e0e0e',
	'panel.border': '#161616',
	'panelInput.border': '#1e1e1e',
	'panelTitle.activeBorder': '#d0d0d0',
	'panelTitle.activeForeground': '#c0c0c0',
	'panelTitle.inactiveForeground': '#505050',
	'peekViewEditor.background': '#111111',
	'peekViewResult.background': '#111111',
	'pickerGroup.border': '#252525',
	'progressBar.background': '#d0d0d0',
	'quickInput.background': '#141414',
	'quickInput.foreground': '#b0b0b0',
	'settings.dropdownBackground': '#161616',
	'settings.dropdownBorder': '#252525',
	'settings.headerForeground': '#d0d0d0',
	'settings.modifiedItemIndicator': '#707070',
	'sideBar.background': '#0e0e0e',
	'sideBar.border': '#141414',
	'sideBar.foreground': '#909090',
	'sideBarSectionHeader.background': '#0e0e0e',
	'sideBarSectionHeader.border': '#161616',
	'sideBarSectionHeader.foreground': '#808080',
	'sideBarTitle.foreground': '#808080',
	'statusBar.background': '#0a0a0a',
	'statusBar.border': '#141414',
	'statusBar.debuggingBackground': '#d0d0d0',
	'statusBar.debuggingForeground': '#0a0a0a',
	'statusBar.focusBorder': '#505050',
	'statusBar.foreground': '#707070',
	'statusBar.noFolderBackground': '#0e0e0e',
	'statusBarItem.focusBorder': '#505050',
	'statusBarItem.prominentBackground': '#252525',
	'statusBarItem.remoteBackground': '#d0d0d0',
	'statusBarItem.remoteForeground': '#0a0a0a',
	'tab.activeBackground': '#111111',
	'tab.activeBorder': '#111111',
	'tab.activeBorderTop': '#d0d0d0',
	'tab.activeForeground': '#e0e0e0',
	'tab.border': 'transparent',
	'tab.hoverBackground': '#141414',
	'tab.inactiveBackground': '#0a0a0a',
	'tab.inactiveForeground': '#505050',
	'tab.lastPinnedBorder': '#252525',
	'tab.selectedBackground': '#141414',
	'tab.selectedBorderTop': '#909090',
	'tab.selectedForeground': '#c0c0c080',
	'tab.unfocusedActiveBorder': '#111111',
	'tab.unfocusedActiveBorderTop': '#161616',
	'tab.unfocusedHoverBackground': '#111111',
	'terminal.foreground': '#b0b0b0',
	'terminal.inactiveSelectionBackground': '#252525',
	'terminal.tab.activeBorder': '#d0d0d0',
	'textBlockQuote.background': '#161616',
	'textBlockQuote.border': '#303030',
	'textCodeBlock.background': '#161616',
	'textLink.activeForeground': '#c0c0c0',
	'textLink.foreground': '#909090',
	'textPreformat.background': '#252525',
	'textPreformat.foreground': '#b0b0b0',
	'textSeparator.foreground': '#161616',
	'titleBar.activeBackground': '#0a0a0a',
	'titleBar.activeForeground': '#909090',
	'titleBar.border': '#141414',
	'titleBar.inactiveBackground': '#0a0a0a',
	'titleBar.inactiveForeground': '#505050',
	'welcomePage.progress.foreground': '#d0d0d0',
	'welcomePage.tileBackground': '#161616',
	'widget.border': '#252525'
};

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#383a49',
	'activityBar.activeBorder': '#0078D4',
	'activityBar.background': '#181818',
	'activityBar.border': '#2B2B2B',
	'activityBar.foreground': '#D7D7D7',
	'activityBar.inactiveForeground': '#868686',
	'activityBarBadge.background': '#0078D4',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#616161',
	'badge.foreground': '#F8F8F8',
	'button.background': '#0078D4',
	'button.border': '#FFFFFF12',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#026EC1',
	'button.secondaryBackground': '#313131',
	'button.secondaryForeground': '#CCCCCC',
	'button.secondaryHoverBackground': '#3C3C3C',
	'chat.slashCommandBackground': '#26477866',
	'chat.slashCommandForeground': '#85B6FF',
	'chat.editedFileForeground': '#E2C08D',
	'checkbox.background': '#313131',
	'checkbox.border': '#3C3C3C',
	'debugToolBar.background': '#181818',
	descriptionForeground: '#9D9D9D',
	'dropdown.background': '#313131',
	'dropdown.border': '#3C3C3C',
	'dropdown.foreground': '#CCCCCC',
	'dropdown.listBackground': '#1F1F1F',
	'editor.background': '#1F1F1F',
	'editor.findMatchBackground': '#9E6A03',
	'editor.foreground': '#CCCCCC',
	'editor.inactiveSelectionBackground': '#3A3D41',
	'editor.selectionHighlightBackground': '#ADD6FF26',
	'editorGroup.border': '#FFFFFF17',
	'editorGroupHeader.tabsBackground': '#181818',
	'editorGroupHeader.tabsBorder': '#2B2B2B',
	'editorGutter.addedBackground': '#2EA043',
	'editorGutter.deletedBackground': '#F85149',
	'editorGutter.modifiedBackground': '#0078D4',
	'editorIndentGuide.activeBackground1': '#707070',
	'editorIndentGuide.background1': '#404040',
	'editorLineNumber.activeForeground': '#CCCCCC',
	'editorLineNumber.foreground': '#6E7681',
	'editorOverviewRuler.border': '#010409',
	'editorWidget.background': '#202020',
	errorForeground: '#F85149',
	focusBorder: '#0078D4',
	foreground: '#CCCCCC',
	'icon.foreground': '#CCCCCC',
	'input.background': '#313131',
	'input.border': '#3C3C3C',
	'input.foreground': '#CCCCCC',
	'input.placeholderForeground': '#989898',
	'inputOption.activeBackground': '#2489DB82',
	'inputOption.activeBorder': '#2488DB',
	'keybindingLabel.foreground': '#CCCCCC',
	'list.activeSelectionIconForeground': '#FFF',
	'list.dropBackground': '#383B3D',
	'menu.background': '#1F1F1F',
	'menu.border': '#454545',
	'menu.foreground': '#CCCCCC',
	'menu.selectionBackground': '#0078d4',
	'menu.separatorBackground': '#454545',
	'notificationCenterHeader.background': '#1F1F1F',
	'notificationCenterHeader.foreground': '#CCCCCC',
	'notifications.background': '#1F1F1F',
	'notifications.border': '#2B2B2B',
	'notifications.foreground': '#CCCCCC',
	'panel.background': '#181818',
	'panel.border': '#2B2B2B',
	'panelInput.border': '#2B2B2B',
	'panelTitle.activeBorder': '#0078D4',
	'panelTitle.activeForeground': '#CCCCCC',
	'panelTitle.inactiveForeground': '#9D9D9D',
	'peekViewEditor.background': '#1F1F1F',
	'peekViewEditor.matchHighlightBackground': '#BB800966',
	'peekViewResult.background': '#1F1F1F',
	'peekViewResult.matchHighlightBackground': '#BB800966',
	'pickerGroup.border': '#3C3C3C',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#0078D4',
	'quickInput.background': '#222222',
	'quickInput.foreground': '#CCCCCC',
	'settings.dropdownBackground': '#313131',
	'settings.dropdownBorder': '#3C3C3C',
	'settings.headerForeground': '#FFFFFF',
	'settings.modifiedItemIndicator': '#BB800966',
	'sideBar.background': '#181818',
	'sideBar.border': '#2B2B2B',
	'sideBar.foreground': '#CCCCCC',
	'sideBarSectionHeader.background': '#181818',
	'sideBarSectionHeader.border': '#2B2B2B',
	'sideBarSectionHeader.foreground': '#CCCCCC',
	'sideBarTitle.foreground': '#CCCCCC',
	'statusBar.background': '#181818',
	'statusBar.border': '#2B2B2B',
	'statusBar.debuggingBackground': '#0078D4',
	'statusBar.debuggingForeground': '#FFFFFF',
	'statusBar.focusBorder': '#0078D4',
	'statusBar.foreground': '#CCCCCC',
	'statusBar.noFolderBackground': '#1F1F1F',
	'statusBarItem.focusBorder': '#0078D4',
	'statusBarItem.prominentBackground': '#6E768166',
	'statusBarItem.remoteBackground': '#0078D4',
	'statusBarItem.remoteForeground': '#FFFFFF',
	'tab.activeBackground': '#1F1F1F',
	'tab.activeBorder': '#1F1F1F',
	'tab.activeBorderTop': '#0078D4',
	'tab.activeForeground': '#FFFFFF',
	'tab.border': '#2B2B2B',
	'tab.hoverBackground': '#1F1F1F',
	'tab.inactiveBackground': '#181818',
	'tab.inactiveForeground': '#9D9D9D',
	'tab.lastPinnedBorder': '#ccc3',
	'tab.selectedBackground': '#222222',
	'tab.selectedBorderTop': '#6caddf',
	'tab.selectedForeground': '#ffffffa0',
	'tab.unfocusedActiveBorder': '#1F1F1F',
	'tab.unfocusedActiveBorderTop': '#2B2B2B',
	'tab.unfocusedHoverBackground': '#1F1F1F',
	'terminal.foreground': '#CCCCCC',
	'terminal.inactiveSelectionBackground': '#3A3D41',
	'terminal.tab.activeBorder': '#0078D4',
	'textBlockQuote.background': '#2B2B2B',
	'textBlockQuote.border': '#616161',
	'textCodeBlock.background': '#2B2B2B',
	'textLink.activeForeground': '#4daafc',
	'textLink.foreground': '#4daafc',
	'textPreformat.background': '#3C3C3C',
	'textPreformat.foreground': '#D0D0D0',
	'textSeparator.foreground': '#21262D',
	'titleBar.activeBackground': '#181818',
	'titleBar.activeForeground': '#CCCCCC',
	'titleBar.border': '#2B2B2B',
	'titleBar.inactiveBackground': '#1F1F1F',
	'titleBar.inactiveForeground': '#9D9D9D',
	'welcomePage.progress.foreground': '#0078D4',
	'welcomePage.tileBackground': '#2B2B2B',
	'widget.border': '#313131'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#dddddd',
	'activityBar.activeBorder': '#005FB8',
	'activityBar.background': '#F8F8F8',
	'activityBar.border': '#E5E5E5',
	'activityBar.foreground': '#1F1F1F',
	'activityBar.inactiveForeground': '#616161',
	'activityBarBadge.background': '#005FB8',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#CCCCCC',
	'badge.foreground': '#3B3B3B',
	'button.background': '#005FB8',
	'button.border': '#0000001a',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#0258A8',
	'button.secondaryBackground': '#E5E5E5',
	'button.secondaryForeground': '#3B3B3B',
	'button.secondaryHoverBackground': '#CCCCCC',
	'chat.slashCommandBackground': '#ADCEFF7A',
	'chat.slashCommandForeground': '#26569E',
	'chat.editedFileForeground': '#895503',
	'checkbox.background': '#F8F8F8',
	'checkbox.border': '#CECECE',
	descriptionForeground: '#3B3B3B',
	'diffEditor.unchangedRegionBackground': '#f8f8f8',
	'dropdown.background': '#FFFFFF',
	'dropdown.border': '#CECECE',
	'dropdown.foreground': '#3B3B3B',
	'dropdown.listBackground': '#FFFFFF',
	'editor.background': '#FFFFFF',
	'editor.foreground': '#3B3B3B',
	'editor.inactiveSelectionBackground': '#E5EBF1',
	'editor.selectionHighlightBackground': '#ADD6FF80',
	'editorGroup.border': '#E5E5E5',
	'editorGroupHeader.tabsBackground': '#F8F8F8',
	'editorGroupHeader.tabsBorder': '#E5E5E5',
	'editorGutter.addedBackground': '#2EA043',
	'editorGutter.deletedBackground': '#F85149',
	'editorGutter.modifiedBackground': '#005FB8',
	'editorIndentGuide.activeBackground1': '#939393',
	'editorIndentGuide.background1': '#D3D3D3',
	'editorLineNumber.activeForeground': '#171184',
	'editorLineNumber.foreground': '#6E7681',
	'editorOverviewRuler.border': '#E5E5E5',
	'editorSuggestWidget.background': '#F8F8F8',
	'editorWidget.background': '#F8F8F8',
	errorForeground: '#F85149',
	focusBorder: '#005FB8',
	foreground: '#3B3B3B',
	'icon.foreground': '#3B3B3B',
	'input.background': '#FFFFFF',
	'input.border': '#CECECE',
	'input.foreground': '#3B3B3B',
	'input.placeholderForeground': '#767676',
	'inputOption.activeBackground': '#BED6ED',
	'inputOption.activeBorder': '#005FB8',
	'inputOption.activeForeground': '#000000',
	'keybindingLabel.foreground': '#3B3B3B',
	'list.activeSelectionBackground': '#E8E8E8',
	'list.activeSelectionForeground': '#000000',
	'list.activeSelectionIconForeground': '#000000',
	'list.focusAndSelectionOutline': '#005FB8',
	'list.hoverBackground': '#F2F2F2',
	'menu.border': '#CECECE',
	'menu.selectionBackground': '#005FB8',
	'menu.selectionForeground': '#ffffff',
	'notebook.cellBorderColor': '#E5E5E5',
	'notebook.selectedCellBackground': '#C8DDF150',
	'notificationCenterHeader.background': '#FFFFFF',
	'notificationCenterHeader.foreground': '#3B3B3B',
	'notifications.background': '#FFFFFF',
	'notifications.border': '#E5E5E5',
	'notifications.foreground': '#3B3B3B',
	'panel.background': '#F8F8F8',
	'panel.border': '#E5E5E5',
	'panelInput.border': '#E5E5E5',
	'panelTitle.activeBorder': '#005FB8',
	'panelTitle.activeForeground': '#3B3B3B',
	'panelTitle.inactiveForeground': '#3B3B3B',
	'peekViewEditor.matchHighlightBackground': '#BB800966',
	'peekViewResult.background': '#FFFFFF',
	'peekViewResult.matchHighlightBackground': '#BB800966',
	'pickerGroup.border': '#E5E5E5',
	'pickerGroup.foreground': '#8B949E',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#005FB8',
	'quickInput.background': '#F8F8F8',
	'quickInput.foreground': '#3B3B3B',
	'searchEditor.textInputBorder': '#CECECE',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#CECECE',
	'settings.headerForeground': '#1F1F1F',
	'settings.modifiedItemIndicator': '#BB800966',
	'settings.numberInputBorder': '#CECECE',
	'settings.textInputBorder': '#CECECE',
	'sideBar.background': '#F8F8F8',
	'sideBar.border': '#E5E5E5',
	'sideBar.foreground': '#3B3B3B',
	'sideBarSectionHeader.background': '#F8F8F8',
	'sideBarSectionHeader.border': '#E5E5E5',
	'sideBarSectionHeader.foreground': '#3B3B3B',
	'sideBarTitle.foreground': '#3B3B3B',
	'statusBar.background': '#F8F8F8',
	'statusBar.border': '#E5E5E5',
	'statusBar.debuggingBackground': '#FD716C',
	'statusBar.debuggingForeground': '#000000',
	'statusBar.focusBorder': '#005FB8',
	'statusBar.foreground': '#3B3B3B',
	'statusBar.noFolderBackground': '#F8F8F8',
	'statusBarItem.compactHoverBackground': '#CCCCCC',
	'statusBarItem.errorBackground': '#C72E0F',
	'statusBarItem.focusBorder': '#005FB8',
	'statusBarItem.hoverBackground': '#B8B8B850',
	'statusBarItem.prominentBackground': '#6E768166',
	'statusBarItem.remoteBackground': '#005FB8',
	'statusBarItem.remoteForeground': '#FFFFFF',
	'tab.activeBackground': '#FFFFFF',
	'tab.activeBorder': '#F8F8F8',
	'tab.activeBorderTop': '#005FB8',
	'tab.activeForeground': '#3B3B3B',
	'tab.border': '#E5E5E5',
	'tab.hoverBackground': '#FFFFFF',
	'tab.inactiveBackground': '#F8F8F8',
	'tab.inactiveForeground': '#868686',
	'tab.lastPinnedBorder': '#D4D4D4',
	'tab.selectedBackground': '#ffffffa5',
	'tab.selectedBorderTop': '#68a3da',
	'tab.selectedForeground': '#333333b3',
	'tab.unfocusedActiveBorder': '#F8F8F8',
	'tab.unfocusedActiveBorderTop': '#E5E5E5',
	'tab.unfocusedHoverBackground': '#F8F8F8',
	'terminal.foreground': '#3B3B3B',
	'terminal.inactiveSelectionBackground': '#E5EBF1',
	'terminal.tab.activeBorder': '#005FB8',
	'terminalCursor.foreground': '#005FB8',
	'textBlockQuote.background': '#F8F8F8',
	'textBlockQuote.border': '#E5E5E5',
	'textCodeBlock.background': '#F8F8F8',
	'textLink.activeForeground': '#005FB8',
	'textLink.foreground': '#005FB8',
	'textPreformat.background': '#0000001F',
	'textPreformat.foreground': '#3B3B3B',
	'textSeparator.foreground': '#21262D',
	'titleBar.activeBackground': '#F8F8F8',
	'titleBar.activeForeground': '#1E1E1E',
	'titleBar.border': '#E5E5E5',
	'titleBar.inactiveBackground': '#F8F8F8',
	'titleBar.inactiveForeground': '#8B949E',
	'welcomePage.tileBackground': '#F3F3F3',
	'widget.border': '#E5E5E5'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';

export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(
		themeId: string | undefined | IWorkbenchColorTheme,
		settingsTarget: ThemeSettingTarget
	): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(
		iconThemeId: string | undefined | IWorkbenchFileIconTheme,
		settingsTarget: ThemeSettingTarget
	): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(
		iconThemeId: string | undefined | IWorkbenchProductIconTheme,
		settingsTarget: ThemeSettingTarget
	): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(
		publisher: string,
		name: string,
		version: string
	): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]:
		| IThemeScopedTokenColorCustomizations
		| ITextMateThemingRule[]
		| ITokenColorizationSetting
		| boolean
		| string
		| undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]:
		| IThemeScopedSemanticTokenColorCustomizations
		| ISemanticTokenRules
		| boolean
		| undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]:
		| IThemeScopedExperimentalSemanticTokenColorCustomizations
		| ISemanticTokenRules
		| undefined;
}

export type IThemeScopedCustomizations =
	| IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	| IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return (
			d && {
				_extensionId: d.extensionId,
				_extensionIsBuiltin: d.extensionIsBuiltin,
				_extensionName: d.extensionName,
				_extensionPublisher: d.extensionPublisher
			}
		);
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (
			o &&
			isString(o._extensionId) &&
			isBoolean(o._extensionIsBuiltin) &&
			isString(o._extensionName) &&
			isString(o._extensionPublisher)
		) {
			return {
				extensionId: o._extensionId,
				extensionIsBuiltin: o._extensionIsBuiltin,
				extensionName: o._extensionName,
				extensionPublisher: o._extensionPublisher
			};
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return {
			extensionPublisher: publisher,
			extensionId: `${publisher}.${name}`,
			extensionName: name,
			extensionIsBuiltin: isBuiltin
		};
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
