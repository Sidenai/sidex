/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/style.css';
import { registerThemingParticipant } from '../../platform/theme/common/themeService.js';
import { WORKBENCH_BACKGROUND, TITLE_BAR_ACTIVE_BACKGROUND } from '../common/theme.js';
import { isWeb, isIOS } from '../../base/common/platform.js';
import { createMetaElement } from '../../base/browser/dom.js';
import { isSafari, isStandalone } from '../../base/browser/browser.js';
import { selectionBackground } from '../../platform/theme/common/colorRegistry.js';
import { mainWindow } from '../../base/browser/window.js';
import { getIconsStyleSheet } from '../../platform/theme/browser/iconsStyleSheet.js';
import { createStyleSheet } from '../../base/browser/domStylesheets.js';

// Eagerly inject icon CSS so aliased codicon rules (e.g. .codicon-search-view-icon)
// are available before the WorkbenchThemeService initialises its own <style> element.
// The theme service will later take over with a themed version; this unthemed fallback
// guarantees icons never render as blank while services spin up.
try {
	const sheet = createStyleSheet();
	sheet.id = 'codiconStyles-fallback';
	const iconsSS = getIconsStyleSheet(undefined);
	const css = iconsSS.getCSS();
	sheet.textContent = css;
	iconsSS.onDidChange(() => {
		sheet.textContent = iconsSS.getCSS();
	});
} catch (e) {
	console.warn('[SideX] Icon stylesheet fallback failed (non-fatal):', e);
}

registerThemingParticipant((theme, collector) => {
	// Background (helps for subpixel-antialiasing on Windows)
	const workbenchBackground = WORKBENCH_BACKGROUND(theme);
	collector.addRule(`.monaco-workbench { background-color: ${workbenchBackground}; }`);

	// Selection (do NOT remove - https://github.com/microsoft/vscode/issues/169662)
	const windowSelectionBackground = theme.getColor(selectionBackground);
	if (windowSelectionBackground) {
		collector.addRule(`.monaco-workbench ::selection { background-color: ${windowSelectionBackground}; }`);
	}

	// Update <meta name="theme-color" content=""> based on selected theme
	if (isWeb) {
		const titleBackground = theme.getColor(TITLE_BAR_ACTIVE_BACKGROUND);
		if (titleBackground) {
			const metaElementId = 'monaco-workbench-meta-theme-color';

			let metaElement = mainWindow.document.getElementById(metaElementId) as HTMLMetaElement | null;
			if (!metaElement) {
				metaElement = createMetaElement();
				metaElement.name = 'theme-color';
				metaElement.id = metaElementId;
			}

			metaElement.content = titleBackground.toString();
		}
	}

	// We disable user select on the root element, however on Safari this seems
	// to prevent any text selection in the monaco editor. As a workaround we
	// allow to select text in monaco editor instances.
	if (isSafari) {
		collector.addRule(`
			body.web {
				touch-action: none;
			}
			.monaco-workbench .monaco-editor .view-lines {
				user-select: text;
				-webkit-user-select: text;
			}
		`);
	}

	// Update body background color to ensure the home indicator area looks similar to the workbench
	if (isIOS && isStandalone()) {
		collector.addRule(`body { background-color: ${workbenchBackground}; }`);
	}
});
