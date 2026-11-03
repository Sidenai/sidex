/*---------------------------------------------------------------------------------------------
 *  Styles for the SideX Settings panel content.
 *  The modal frame uses real VS Code classes with inline styles for the
 *  structural layout. This file styles the inner content (nav, rows, controls).
 *  Every var() includes a fallback so the panel renders even when
 *  VS Code theme variables aren't in scope.
 *--------------------------------------------------------------------------------------------*/

let _styleElement: HTMLStyleElement | null = null;

export function ensureSettingsStyles(): void {
	if (!_styleElement) {
		_styleElement = document.createElement('style');
		_styleElement.id = 'sidex-settings-panel-styles';
		document.head.appendChild(_styleElement);
	}
	_styleElement.textContent = SETTINGS_CSS;
}

const SETTINGS_CSS = `
/* ============================================================
   SIDEBAR SEARCH
   ============================================================ */
.sidex-settings-search {
	padding: 0 6px 12px;
	flex-shrink: 0;
}
.sidex-settings-search .sidex-search-wrapper {
	display: flex;
	align-items: center;
	width: 100%;
	box-sizing: border-box;
	height: 28px;
	line-height: 28px;
	padding: 0 4px;
	background-color: var(--vscode-menu-background, var(--vscode-dropdown-background));
	color: var(--vscode-foreground, #ccc);
	border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.09));
	border-radius: 6px;
	overflow: hidden;
}
.sidex-settings-search .sidex-search-wrapper input {
	flex: 1;
	min-width: 0;
	height: 26px;
	background: transparent;
	color: inherit;
	border: none;
	outline: none;
	padding: 0 4px;
	font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
	font-size: 12px;
}
.sidex-settings-search .sidex-search-wrapper input::placeholder {
	color: var(--vscode-input-placeholderForeground, #7a7a7a);
}

/* ============================================================
   ACCOUNT SECTION
   ============================================================ */
.sidex-settings-account {
	padding: 16px 6px 12px;
	flex-shrink: 0;
}
.sidex-settings-account-info {
	display: flex;
	align-items: center;
	gap: 8px;
}
.sidex-settings-account-details {
	flex: 1;
	min-width: 0;
}
.sidex-settings-account-name {
	font-size: 11px;
	color: var(--vscode-descriptionForeground, #9d9d9d);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	opacity: 0.7;
}
.sidex-settings-account-email {
	font-size: 11px;
	font-weight: 500;
	color: var(--vscode-foreground, #ccc);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
/* ============================================================
   NAV (Symmetrical, 6px rounded)
   ============================================================ */
.sidex-settings-nav {
	flex: 1;
	overflow-y: auto;
	padding: 0 6px 6px;
}
.sidex-settings-nav::-webkit-scrollbar {
	width: 4px;
}
.sidex-settings-nav::-webkit-scrollbar-thumb {
	background: var(--vscode-scrollbarSlider-background, rgba(255,255,255,0.06));
	border-radius: 2px;
}
.sidex-settings-nav-item {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 10px;
	margin: 2px 0;
	cursor: pointer;
	font-size: 12px;
	height: auto;
	min-height: 26px;
	box-sizing: border-box;
	color: var(--vscode-foreground, #ccc);
	opacity: 0.8;
	border-radius: 6px;
	user-select: none;
	-webkit-user-select: none;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	transition: background-color 100ms ease, color 100ms ease;
}
.sidex-settings-nav-item:hover {
	background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
	opacity: 1;
}
.sidex-settings-nav-item.active {
	background: var(--vscode-menu-background, var(--vscode-dropdown-background, #1e1e1e));
	color: var(--vscode-foreground, #fff);
	opacity: 1;
	font-weight: 500;
}
.sidex-settings-nav-item .codicon {
	font-size: 14px;
	opacity: 0.7;
	flex-shrink: 0;
}
.sidex-settings-nav-item.active .codicon {
	opacity: 1;
}
.sidex-settings-nav-item.disabled {
	opacity: 0.35;
	pointer-events: none;
	cursor: default;
}
.sidex-settings-nav-item-external {
	margin-left: auto;
	opacity: 0.4;
	font-size: 11px;
}
.sidex-settings-nav-separator {
	height: 1px;
	background: var(--vscode-widget-border, rgba(255,255,255,0.09));
	margin: 10px 10px;
}

/* ============================================================
   CONTENT
   ============================================================ */
.sidex-settings-content {
	padding: 0;
	background-color: var(--vscode-sideBar-background, #141414);
	min-width: 0;
	min-height: 0;
}
.sidex-settings-content::-webkit-scrollbar {
	width: 0;
	height: 0;
}
.sidex-settings-scroll-section {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin-bottom: 24px;
}

/* Custom scrollbar */
.content > .scrollbar {
	z-index: 11;
}
.content > .scrollbar.visible {
	opacity: 1;
	background: rgba(0,0,0,0);
	transition: opacity 120ms ease;
}
.content > .scrollbar.invisible {
	opacity: 0;
	pointer-events: none;
}
.content > .scrollbar.invisible.fade {
	transition: opacity 600ms ease;
}
.content > .scrollbar > .slider {
	background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.4));
	border-radius: 4px;
	transition: background-color 120ms ease;
}
.content > .scrollbar > .slider:hover {
	background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,0.7));
}
.content > .scrollbar > .slider:active {
	background: var(--vscode-scrollbarSlider-activeBackground, rgba(191,191,191,0.4));
}

/* ============================================================
   SECTION TITLE (Sleek Devin H2 style)
   ============================================================ */
.sidex-settings-section-title {
	display: inline-block;
	margin: 0;
	font-weight: 500;
	font-size: 16px;
	height: auto;
	box-sizing: border-box;
	padding: 24px 20px 8px;
	width: 100%;
	position: relative;
	overflow: hidden;
	text-overflow: ellipsis;
	text-transform: none;
	letter-spacing: normal;
	color: var(--vscode-foreground, #ccc);
	border: none !important;
}

/* ============================================================
   SETTING ROW (Meticulously structured interior card rows)
   ============================================================ */
.sidex-settings-row {
	position: relative;
	display: flex;
	justify-content: space-between;
	align-items: center;
	min-height: 58px;
	padding: 12px 20px;
	white-space: normal;
	box-sizing: border-box;
	margin: 0;
	border-radius: 0;
	background: transparent;
	transition: background-color 150ms ease;
}
.sidex-settings-row:first-child {
	border-top-left-radius: 9px;
	border-top-right-radius: 9px;
}
.sidex-settings-row:last-child {
	border-bottom-left-radius: 9px;
	border-bottom-right-radius: 9px;
}
.sidex-settings-row::after {
	content: '';
	position: absolute;
	bottom: 0;
	left: 20px;
	right: 20px;
	height: 1px;
	background-color: var(--vscode-widget-border, rgba(255,255,255,0.09));
}
.sidex-settings-row:last-child::after {
	display: none; /* Last item inside card has no divider */
}
.sidex-settings-row-label {
	font-weight: 500;
	font-size: 13px;
	color: var(--vscode-foreground, #ccc);
	user-select: text;
	-webkit-user-select: text;
}
.sidex-settings-row-description {
	margin-top: 2px;
	color: var(--vscode-descriptionForeground, #888);
	font-size: 12px;
	line-height: 1.4;
	user-select: text;
	-webkit-user-select: text;
}
.sidex-settings-row-description a {
	color: var(--vscode-textLink-foreground, #4daafc);
	text-decoration: none;
}
.sidex-settings-row-description a:hover {
	color: var(--vscode-textLink-activeForeground, #74b9fc);
	text-decoration: underline;
}
.sidex-settings-row-description code {
	font-family: var(--monaco-monospace-font, monospace);
	font-size: 11px;
	color: var(--vscode-textPreformat-foreground, #d4d4d4);
	background-color: var(--vscode-textPreformat-background, #3c3c3c);
	padding: 1px 3px;
	border-radius: 4px;
}
.sidex-settings-row-action {
	margin-top: 0;
	display: flex;
	flex-shrink: 0;
}

/* ============================================================
   INPUT & NUMBER FIELDS (6px rounding, dropdown coloring)
   ============================================================ */
.sidex-input-wrapper {
	display: block;
	position: relative;
	box-sizing: border-box;
	padding: 0;
	border-radius: 6px;
	border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.09));
	background: var(--vscode-menu-background, var(--vscode-dropdown-background));
	transition: border-color 0.15s ease;
	width: 100%;
	max-width: 320px;
}
.sidex-input-wrapper input {
	display: inline-block;
	box-sizing: border-box;
	width: 100%;
	height: 100%;
	border: none;
	font-family: inherit;
	font-size: 13px;
	resize: none;
	color: var(--vscode-foreground, #ccc);
	background: transparent;
	padding: 5px 10px;
	outline: none;
}

.sidex-number-input-wrapper {
	display: block;
	position: relative;
	box-sizing: border-box;
	padding: 0;
	border-radius: 6px;
	border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.09));
	background: var(--vscode-menu-background, var(--vscode-dropdown-background));
	transition: border-color 0.15s ease;
	min-width: 200px;
}
.sidex-number-input-wrapper input {
	display: inline-block;
	box-sizing: border-box;
	width: 100%;
	border: none;
	font-family: inherit;
	font-size: 13px;
	color: var(--vscode-foreground, #ccc);
	background: transparent;
	padding: 5px 10px;
	outline: none;
	-moz-appearance: textfield;
	appearance: textfield;
}

/* ============================================================
   TOGGLE SWITCH (Sleek 6px rounded switch matching the UI)
   ============================================================ */
.sidex-settings-toggle {
	position: relative;
	width: 36px;
	height: 20px;
	border: 1px solid transparent;
	border-radius: 6px;
	padding: 0;
	appearance: none;
	-webkit-appearance: none;
	background: rgba(255, 255, 255, 0.04);
	cursor: pointer;
	transition: background-color 150ms ease, border-color 150ms ease;
	flex-shrink: 0;
	box-sizing: border-box;
}
.sidex-settings-toggle.on {
	background: var(--vscode-button-background, #0078d4);
	border-color: var(--vscode-button-background, #0078d4);
}
.sidex-settings-toggle::after {
	content: '';
	position: absolute;
	top: 2px;
	left: 2px;
	width: 14px;
	height: 14px;
	border-radius: 4px;
	background: #ffffff;
	box-shadow: 0 1px 3px rgba(0,0,0,0.3);
	transition: transform 150ms ease;
}
.sidex-settings-toggle.on::after {
	transform: translateX(16px);
}

/* ============================================================
   BUTTONS (Symmetrical, 6px rounded, borderless)
   ============================================================ */
.sidex-settings-btn {
	padding: 4px 12px;
	border-radius: 6px;
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
	border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.09));
	background: var(--vscode-menu-background, var(--vscode-dropdown-background));
	color: var(--vscode-foreground, #ccc);
	font-family: inherit;
	transition: background-color 100ms ease;
	white-space: nowrap;
	flex-shrink: 0;
}
.sidex-settings-btn:hover {
	background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
}
.sidex-settings-btn-primary {
	background: var(--vscode-button-background, #0078d4);
	color: var(--vscode-button-foreground, #fff);
	border: 1px solid var(--vscode-button-background, #0078d4);
}
.sidex-settings-btn-primary:hover {
	background: var(--vscode-button-hoverBackground, #026ec1);
}
/* ============================================================
   SEGMENTED CONTROL
   ============================================================ */
.sidex-settings-segmented-control {
	display: flex;
	background: var(--vscode-menu-background, #1e1e1e);
	border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.09));
	border-radius: 6px;
	padding: 2px;
	gap: 2px;
}
.sidex-settings-segment-btn {
	padding: 4px 10px;
	border: none;
	border-radius: 4px;
	font-size: 11px;
	font-weight: 500;
	cursor: pointer;
	background: transparent;
	color: var(--vscode-descriptionForeground);
	transition: background 0.1s, color 0.1s;
}
.sidex-settings-segment-btn.active {
	background: var(--vscode-button-secondaryBackground, #313131);
	color: var(--vscode-button-secondaryForeground, #fff);
}

/* ============================================================
   CARDS (Symmetrical 10px rounded cards matching the Devin image)
   ============================================================ */
.sidex-settings-card {
	border: none;
	border-radius: 10px;
	padding: 0 !important;
	margin: 0 20px;
	background: var(--vscode-menu-background, var(--vscode-dropdown-background));
	overflow: visible;
}

/* Subsection header */
.sidex-settings-subsection-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 16px 38px 0;
}
.sidex-settings-subsection-header .sidex-settings-section-title {
	padding: 0;
	border-top: none;
	width: auto;
}

/* Section description (under titles) */
.sidex-settings-section-desc {
	padding: 0 38px 8px;
}

/* Empty state */
.sidex-settings-empty-state {
	padding: 24px;
	text-align: center;
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
}

/* ============================================================
   PROGRESS BAR
   ============================================================ */
.sidex-settings-progress {
	width: 100%;
	height: 6px;
	border-radius: 3px;
	background: var(--vscode-widget-border, rgba(255,255,255,0.09));
	overflow: hidden;
	margin: 8px 0;
}
.sidex-settings-progress-bar {
	height: 100%;
	border-radius: 3px;
	background: var(--vscode-progressBar-background, #0078d4);
	transition: width 0.3s ease;
}
.sidex-usage-meter {
	flex-direction: column;
	align-items: stretch;
	gap: 6px;
}
.sidex-usage-meter-oneline {
	flex-direction: row;
	align-items: center;
	gap: 10px;
	min-height: 44px;
}
.sidex-usage-meter-bar-inline {
	flex: 1;
	min-width: 48px;
	margin: 0;
}
.sidex-usage-meter-top {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	width: 100%;
}
.sidex-product-label-row {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}
.sidex-product-mark {
	width: 16px;
	height: 16px;
	flex-shrink: 0;
	color: var(--vscode-foreground, #ccc);
	display: inline-flex;
}
.sidex-product-mark svg {
	width: 16px;
	height: 16px;
	display: block;
}
.sidex-product-mark-claude-code {
	color: #d97757;
}

/* ============================================================
   MODEL LIST
   ============================================================ */
.sidex-settings-model-item {
	position: relative;
	display: flex;
	align-items: center;
	gap: 10px;
	min-height: 58px;
	padding: 12px 20px;
	box-sizing: border-box;
	border-radius: 0;
	border: none;
	margin: 0;
	transition: background 0.1s ease;
}
.sidex-settings-model-item::after {
	content: '';
	position: absolute;
	bottom: 0;
	left: 20px;
	right: 20px;
	height: 1px;
	background-color: var(--vscode-widget-border, rgba(255,255,255,0.09));
}
.sidex-settings-model-item:last-child::after {
	display: none;
}
.sidex-settings-model-name {
	flex: 1;
	font-size: 13px;
	color: var(--vscode-foreground, #ccc);
}
.sidex-settings-model-remove {
	opacity: 0.4;
	cursor: pointer;
	transition: opacity 0.1s;
}
.sidex-settings-model-remove:hover {
	opacity: 1;
	color: var(--vscode-errorForeground, #f85149);
}

.sidex-settings-model-search {
	display: flex;
	align-items: center;
	box-sizing: border-box;
	border-radius: 6px;
	border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.09));
	background: var(--vscode-menu-background, var(--vscode-dropdown-background));
	margin: 12px 20px 8px;
	padding: 0 8px;
	gap: 6px;
	transition: border-color 0.15s ease;
}
.sidex-settings-model-search .codicon {
	font-size: 14px;
	opacity: 0.5;
}
.sidex-settings-model-search input {
	display: inline-block;
	box-sizing: border-box;
	width: 100%;
	border: none;
	font-family: inherit;
	font-size: 13px;
	color: var(--vscode-foreground, #ccc);
	background: transparent;
	padding: 5px 0;
	outline: none;
}
.sidex-settings-model-search input::placeholder {
	color: var(--vscode-input-placeholderForeground, #7a7a7a);
}

.sidex-settings-model-group-header {
	font-size: 11px;
	font-weight: 600;
	color: var(--vscode-descriptionForeground, #9d9d9d);
	padding: 12px 20px 4px;
	text-transform: uppercase;
	letter-spacing: 0.5px;
}

.sidex-models-enabled-list {
	margin: 0;
}

/* ============================================================
   EXPANDABLE SECTIONS
   ============================================================ */
.sidex-settings-expandable-header {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 8px 10px;
	cursor: pointer;
	font-size: 13px;
	font-weight: 500;
	color: var(--vscode-foreground, #ccc);
	border-radius: 6px;
	margin: 0 20px;
}
.sidex-settings-expandable-header .codicon {
	font-size: 12px;
	transition: transform 0.15s;
}
.sidex-settings-expandable-header.expanded .codicon {
	transform: rotate(90deg);
}
.sidex-settings-expandable-content {
	display: none;
	padding: 0;
}
.sidex-settings-expandable-content.visible {
	display: block;
}

/* ============================================================
   LINKS
   ============================================================ */
.sidex-settings-link {
	color: var(--vscode-textLink-foreground, #4daafc);
	text-decoration: none;
}
.sidex-settings-link:hover {
	text-decoration: underline;
	color: var(--vscode-textLink-activeForeground, #74b9fc);
}

/* ============================================================
   MODIFIED INDICATOR
   ============================================================ */
.sidex-settings-row.is-configured::before {
	content: '';
	position: absolute;
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background-color: var(--vscode-descriptionForeground, #9d9d9d);
	left: 4px;
	top: 20px;
}

/* ============================================================
   DEVIN-STYLE LISTS & INTERACTIVE BOXES (No Hover Background)
   ============================================================ */
.sidex-settings-list-box {
	overflow: hidden;
	border-radius: 10px;
	border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.09));
	margin-top: 8px;
}
.sidex-settings-list-scroll {
	max-height: 50vh;
	min-height: 120px;
	overflow-y: auto;
	padding: 6px;
	box-sizing: border-box;
	scrollbar-width: none; /* Hide scrollbars */
}
.sidex-settings-list-scroll::-webkit-scrollbar {
	display: none; /* Hide scrollbars */
}
.sidex-settings-list-item {
	position: relative;
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 28px;
	border-radius: 6px;
	padding: 4px 10px;
	font-size: 12px;
	color: var(--vscode-foreground);
	transition: background-color 100ms ease;
}
.sidex-settings-list-item::after {
	content: '';
	position: absolute;
	bottom: 0;
	left: 20px;
	right: 20px;
	height: 1px;
	background-color: var(--vscode-widget-border, rgba(255,255,255,0.09));
}
.sidex-settings-list-item:last-child::after {
	display: none;
}
.sidex-settings-list-item-actions {
	display: flex;
	align-items: center;
	gap: 6px;
	opacity: 0;
	transition: opacity 100ms ease;
}
.sidex-settings-list-item:hover .sidex-settings-list-item-actions {
	opacity: 1;
}
.sidex-settings-list-action-btn {
	cursor: pointer;
	opacity: 0.6;
	transition: opacity 100ms ease;
	display: inline-flex;
	align-items: center;
}
.sidex-settings-list-action-btn:hover {
	opacity: 1;
}

/* ============================================================
   CUSTOM DROPDOWN (Devin / Tray Menu style)
   ============================================================ */
.sidex-custom-select-container {
	position: relative;
	display: inline-block;
}
.sidex-custom-select-trigger {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	height: 26px;
	min-width: 110px;
	padding: 4px 10px;
	border-radius: 6px;
	border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.09));
	background: var(--vscode-menu-background, var(--vscode-dropdown-background, #1e1e1e));
	color: var(--vscode-foreground, #ccc);
	font-size: 12px;
	cursor: pointer;
	box-sizing: border-box;
	user-select: none;
	transition: border-color 0.15s ease;
}
.sidex-custom-select-trigger .codicon {
	font-size: 10px;
	opacity: 0.7;
	transition: transform 0.15s ease;
}
.sidex-custom-select-container.open .sidex-custom-select-trigger .codicon {
	transform: rotate(180deg);
}
.sidex-custom-dropdown-menu {
	position: absolute;
	top: 100%;
	left: 0;
	right: 0;
	margin-top: 4px;
	background: var(--vscode-menu-background, #1e1e1e);
	border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.09));
	border-radius: 6px;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
	padding: 4px;
	z-index: 9999;
	display: none;
	flex-direction: column;
	gap: 2px;
	box-sizing: border-box;
	overflow-x: hidden;
}
.sidex-custom-select-container.open .sidex-custom-dropdown-menu {
	display: flex;
}
.sidex-custom-dropdown-item {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 6px 10px;
	border-radius: 4px;
	color: var(--vscode-foreground, #ccc);
	font-size: 12px;
	cursor: pointer;
	user-select: none;
	transition: background 0.1s ease, color 0.1s ease;
	white-space: nowrap;
	min-width: 0;
	overflow: hidden;
}
.sidex-custom-dropdown-item .truncate {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
	flex: 1;
}
.sidex-custom-dropdown-item:hover {
	background: var(--vscode-menu-hoverBackground, rgba(255, 255, 255, 0.08));
	color: var(--vscode-menu-hoverForeground, #fff);
}
.sidex-custom-dropdown-item.active {
	background: var(--vscode-button-secondaryBackground, #313131);
	color: var(--vscode-button-secondaryForeground, #fff);
	font-weight: 500;
}
.sidex-custom-dropdown-item.disabled {
	opacity: 0.4;
	cursor: not-allowed;
	pointer-events: none;
}
.sidex-custom-dropdown-item-soon {
	font-size: 10px;
	opacity: 0.6;
	margin-left: auto;
	padding-right: 4px;
}

/* Keep mouse focus clean but preserve keyboard-visible focus. */
.monaco-workbench .modal-editor-part input:focus,
.monaco-workbench .modal-editor-part button:focus,
.monaco-workbench .modal-editor-part select:focus,
.monaco-workbench .monaco-select-box:focus,
.monaco-workbench .modal-editor-part textarea:focus,
.monaco-workbench .modal-editor-part [tabindex]:focus,
.monaco-workbench .modal-editor-part .sidex-settings-toggle:focus,
.monaco-workbench .modal-editor-part .sidex-custom-select-trigger:focus,
.monaco-workbench .modal-editor-part .sidex-search-wrapper:focus-within,
.monaco-workbench .modal-editor-part .sidex-settings-model-search:focus-within {
	outline: none !important;
	outline-width: 0 !important;
	box-shadow: none !important;
}
.monaco-workbench .modal-editor-part input:focus-visible,
.monaco-workbench .modal-editor-part button:focus-visible,
.monaco-workbench .modal-editor-part select:focus-visible,
.monaco-workbench .modal-editor-part textarea:focus-visible,
.monaco-workbench .modal-editor-part [tabindex]:focus-visible,
.monaco-workbench .modal-editor-part .sidex-settings-toggle:focus-visible,
.monaco-workbench .modal-editor-part .sidex-custom-select-trigger:focus-visible {
	outline: 1px solid var(--vscode-focusBorder) !important;
	outline-offset: 1px !important;
	box-shadow: none !important;
}
`;

export interface DropdownOption {
	value: string;
	label: string;
	disabled?: boolean;
	disabledTitle?: string;
	isSoon?: boolean;
}

export function createCustomDropdown(
	options: (string | DropdownOption)[],
	currentValue: string,
	onChange: (newValue: string) => void
): HTMLElement {
	const container = document.createElement('div');
	container.className = 'sidex-custom-select-container';
	(container as any).value = currentValue;

	const normalizedOpts: DropdownOption[] = options.map(opt => {
		if (typeof opt === 'string') {
			return { value: opt, label: opt };
		}
		return opt;
	});

	const activeOpt = normalizedOpts.find(o => o.value === currentValue) || normalizedOpts[0];

	// Trigger button
	const trigger = document.createElement('div');
	trigger.className = 'sidex-custom-select-trigger';
	trigger.tabIndex = 0;
	trigger.setAttribute('role', 'button');
	trigger.setAttribute('aria-haspopup', 'listbox');
	trigger.setAttribute('aria-expanded', 'false');

	const textSpan = document.createElement('span');
	textSpan.className = 'sidex-custom-select-text';
	textSpan.textContent = activeOpt ? activeOpt.label : currentValue;
	trigger.appendChild(textSpan);

	const iconSpan = document.createElement('span');
	iconSpan.className = 'codicon codicon-chevron-down';
	trigger.appendChild(iconSpan);

	container.appendChild(trigger);

	// Dropdown menu
	const menu = document.createElement('div');
	menu.className = 'sidex-custom-dropdown-menu';
	menu.setAttribute('role', 'listbox');

	for (const opt of normalizedOpts) {
		const item = document.createElement('div');
		item.className = 'sidex-custom-dropdown-item';
		item.setAttribute('role', 'option');
		item.setAttribute('aria-selected', String(opt.value === currentValue));
		if (opt.value === currentValue) {
			item.classList.add('active');
		}
		if (opt.disabled) {
			item.classList.add('disabled');
			if (opt.disabledTitle) {
				item.title = opt.disabledTitle;
			}
		}

		// Inner label
		const labelSpan = document.createElement('span');
		labelSpan.className = 'truncate';
		labelSpan.textContent = opt.label;
		item.title = opt.label;
		item.appendChild(labelSpan);

		// "soon" label if isSoon is true
		if (opt.isSoon) {
			const soonSpan = document.createElement('span');
			soonSpan.className = 'sidex-custom-dropdown-item-soon';
			soonSpan.textContent = 'soon';
			item.appendChild(soonSpan);
		}

		item.addEventListener('click', (e) => {
			if (opt.disabled) {
				e.stopPropagation();
				return;
			}
			textSpan.textContent = opt.label;
			(container as any).value = opt.value;
			
			// Update active class
			const items = menu.querySelectorAll('.sidex-custom-dropdown-item');
			items.forEach(itm => {
				itm.classList.remove('active');
				itm.setAttribute('aria-selected', 'false');
			});
			item.classList.add('active');
			item.setAttribute('aria-selected', 'true');

			onChange(opt.value);
			container.classList.remove('open');
			trigger.setAttribute('aria-expanded', 'false');
			e.stopPropagation();
		});

		menu.appendChild(item);
	}

	container.appendChild(menu);

	// Event listeners to toggle open/close
	trigger.addEventListener('click', (e) => {
		const isOpen = container.classList.contains('open');
		// Close all other dropdowns first
		document.querySelectorAll('.sidex-custom-select-container').forEach(c => {
			if (c !== container) { c.classList.remove('open'); }
		});
		if (isOpen) {
			container.classList.remove('open');
		} else {
			container.classList.add('open');
		}
		trigger.setAttribute('aria-expanded', String(!isOpen));
		e.stopPropagation();
	});
	trigger.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			trigger.click();
		} else if (e.key === 'Escape') {
			container.classList.remove('open');
			trigger.setAttribute('aria-expanded', 'false');
		}
	});

	// Global click handler to close menu when clicking outside
	const globalClickHandler = () => {
		container.classList.remove('open');
		trigger.setAttribute('aria-expanded', 'false');
	};
	document.addEventListener('click', globalClickHandler);

	(container as any).setValue = (val: string) => {
		const opt = normalizedOpts.find(o => o.value === val);
		if (opt) {
			textSpan.textContent = opt.label;
			(container as any).value = val;
			const items = menu.querySelectorAll('.sidex-custom-dropdown-item');
			items.forEach((itm, idx) => {
				if (normalizedOpts[idx].value === val) {
					itm.classList.add('active');
					itm.setAttribute('aria-selected', 'true');
				} else {
					itm.classList.remove('active');
					itm.setAttribute('aria-selected', 'false');
				}
			});
		}
	};

	return container;
}
