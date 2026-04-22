/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const enum AccessibilityVerbositySettingId {
	Terminal = 'accessibility.verbosity.terminal',
	DiffEditor = 'accessibility.verbosity.diffEditor',
	Chat = 'accessibility.verbosity.chat',
	InlineChat = 'accessibility.verbosity.inlineChat',
	InlineCompletions = 'accessibility.verbosity.inlineCompletions',
	KeybindingsEditor = 'accessibility.verbosity.keybindingsEditor',
	Notebook = 'accessibility.verbosity.notebook',
	Editor = 'accessibility.verbosity.editor',
	Hover = 'accessibility.verbosity.hover',
	Notification = 'accessibility.verbosity.notification',
	EmptyEditorHint = 'accessibility.verbosity.emptyEditorHint',
	ReplEditor = 'accessibility.verbosity.replEditor',
	ReplInputHint = 'accessibility.verbosity.replInputHint',
	Comments = 'accessibility.verbosity.comments',
	DiffEditorActive = 'accessibility.verbosity.diffEditorActive',
	Debug = 'accessibility.verbosity.debug',
	Walkthrough = 'accessibility.verbosity.walkthrough',
	Scm = 'accessibility.verbosity.scm',
	Search = 'accessibility.verbosity.search',
	Markers = 'accessibility.verbosity.markers',
	Output = 'accessibility.verbosity.output',
	Webview = 'accessibility.verbosity.webview',
	PanelChat = 'accessibility.verbosity.panelChat'
}

export const accessibleViewIsShown = new RawContextKey<boolean>('accessibleViewIsShown', false);
export const accessibleViewCurrentProviderId = new RawContextKey<string>('accessibleViewCurrentProviderId', undefined);
export const accessibleViewOnLastLine = new RawContextKey<boolean>('accessibleViewOnLastLine', false);
