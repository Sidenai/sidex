/*---------------------------------------------------------------------------------------------
 *  SideX — Tauri-based VSCode port
 *  Entry point. Globals set by inline script in index.html.
 *--------------------------------------------------------------------------------------------*/

import { loadNlsMessages } from './nls-loader.js';

async function sidexOpenFolder() {
	try {
		const { open } = await import('@tauri-apps/plugin-dialog');
		const { URI } = await import('./vs/base/common/uri.js');
		const selected = await open({ directory: true, multiple: false });
		if (selected && typeof selected === 'string') {
			navigateToFolder(URI.file(selected).toString());
		}
	} catch (e) {
		console.error('[SideX] Failed to open folder picker:', e);
	}
}
(window as any).__sidex_openFolder = sidexOpenFolder;

function navigateToFolder(folderUri: string) {
	const url = new URL(window.location.href);
	url.searchParams.set('folder', folderUri);
	window.location.href = url.toString();
}

async function boot() {
	// Load locale translations before any VS Code module imports
    await loadNlsMessages();

	const stages = [
		['common',       () => import('./vs/workbench/workbench.common.main.js')],
		['web.main',     () => import('./vs/workbench/browser/web.main.js')],
		['web-dialog',   () => import('./vs/workbench/browser/parts/dialogs/dialog.web.contribution.js')],
		['web-services', () => import('./vs/workbench/workbench.web.main.js')],
	] as const;

	for (const [label, loader] of stages) {
		try {
			await loader();
		} catch (e) {
			console.error(`[SideX] Barrel stage "${label}" failed:`, e);
			throw e;
		}
	}

	const { create } = await import('./vs/workbench/browser/web.factory.js');
	const { URI } = await import('./vs/base/common/uri.js');

	if (document.readyState === 'loading') {
		await new Promise<void>(r => window.addEventListener('DOMContentLoaded', () => r()));
	}

	const urlParams = new URLSearchParams(window.location.search);
	const folderParam = urlParams.get('folder');

	let workspace: any = undefined;
	if (folderParam) {
		const parsed = URI.parse(folderParam);
		if (parsed.scheme === 'file' || parsed.scheme === 'vscode-remote' || parsed.scheme === 'vscode-vfs') {
			workspace = { folderUri: parsed };
		}
	}

	const options: any = {
		initialColorTheme: {
			themeType: 'dark',
		},

		additionalTrustedDomains: [
			'https://github.com',
			'https://*.github.com',
			'https://*.githubusercontent.com',
		],

		// The workspace provider tells VSCode what folder/workspace to open
		workspaceProvider: {
			workspace,
			trusted: true,
			open: async (_workspace: any, _options: any) => {
				// When VSCode asks to open a new workspace, reload with the folder param
				if (_workspace && 'folderUri' in _workspace) {
					navigateToFolder(_workspace.folderUri.toString());
				}
				return true;
			},
		},
		windowIndicator: {
			label: folderParam ? decodeURIComponent(folderParam.split('/').pop() || 'SideX') : 'SideX',
			tooltip: 'SideX — Tauri Code Editor',
			command: undefined,
		},
		productConfiguration: {
			nameShort: 'SideX',
			nameLong: 'SideX',
			applicationName: 'sidex',
			dataFolderName: '.sidex',
			version: '1.110.0',
			linkProtectionTrustedDomains: [
				'https://github.com',
				'https://*.github.com',
				'https://*.githubusercontent.com',
			],
		},
		settingsSyncOptions: {
			enabled: false,
		},
		additionalBuiltinExtensions: [],
		configurationDefaults: {
			'workbench.startupEditor': 'welcomePage',
			'workbench.enableExperiments': false,
			'workbench.iconTheme': 'vs-seti',
			'workbench.colorTheme': 'Default Dark Modern',
			'editor.experimentalGpuAcceleration': 'auto',
			'workbench.productIconTheme': 'Default',
			'workbench.editor.showTabs': 'multiple',
			'workbench.editor.enablePreview': false,
			'workbench.editor.tabCloseButton': 'right',
			'window.menuBarVisibility': navigator.userAgent.includes('Mac') ? 'hidden' : 'classic',
			'window.titleBarStyle': 'custom',
			'window.commandCenter': true,
			'scm.defaultViewMode': 'list',
			'telemetry.telemetryLevel': 'off',
			'update.mode': 'none',
			'update.showReleaseNotes': false,
			'extensions.autoUpdate': false,
			'extensions.autoCheckUpdates': false,
			'extensions.autoRestart': true,
			'workbench.settings.enableNaturalLanguageSearch': false,
			'chat.editor.enabled': false,
			'chat.commandCenter.enabled': false,
			'editor.bracketPairColorization.enabled': true,
			'editor.guides.bracketPairs': true,
			'editor.linkedEditing': true,
			'editor.suggest.showStatusBar': true,
			'editor.inlineSuggest.enabled': true,
			'editor.stickyScroll.enabled': true,
			'editor.minimap.enabled': false,
			'terminal.integrated.defaultProfile.osx': 'zsh',
			'terminal.integrated.defaultProfile.linux': 'bash',
			'terminal.integrated.profiles.osx': {
				'zsh': { 'path': 'zsh', 'args': ['-l'] },
				'bash': { 'path': 'bash', 'args': ['-l'], 'icon': 'terminal-bash' },
				'fish': { 'path': 'fish', 'args': ['-l'] },
				'tmux': { 'path': 'tmux', 'icon': 'terminal-tmux' },
				'pwsh': { 'path': 'pwsh', 'icon': 'terminal-powershell' },
			},
			'terminal.integrated.profiles.linux': {
				'bash': { 'path': 'bash', 'args': ['-l'], 'icon': 'terminal-bash' },
				'zsh': { 'path': 'zsh', 'args': ['-l'] },
				'fish': { 'path': 'fish', 'args': ['-l'] },
				'tmux': { 'path': 'tmux', 'icon': 'terminal-tmux' },
				'pwsh': { 'path': 'pwsh', 'icon': 'terminal-powershell' },
			},
			'terminal.integrated.enablePersistentSessions': false,
			'editor.formatOnPaste': false,
			'editor.renderWhitespace': 'selection',
			'editor.smoothScrolling': false,
			'editor.cursorBlinking': 'smooth',
			'editor.cursorSmoothCaretAnimation': 'off',
			'editor.mouseWheelZoom': true,
			'editor.wordWrap': 'off',
			'editor.suggest.preview': true,
			'editor.parameterHints.enabled': true,
			'editor.hover.enabled': true,
			'editor.folding': true,
			'editor.foldingImportsByDefault': true,
			'editor.showFoldingControls': 'mouseover',
			'editor.glyphMargin': true,
			'editor.lightbulb.enabled': 'on',
			'editor.colorDecorators': true,
			'editor.renderLineHighlight': 'all',
			'editor.matchBrackets': 'always',
			'editor.occurrencesHighlight': 'singleFile',
			'workbench.editor.highlightModifiedTabs': true,
			'workbench.tree.renderIndentGuides': 'always',
			'security.workspace.trust.startupPrompt': 'never',
			'security.workspace.trust.banner': 'never',
			'security.workspace.trust.enabled': false,
		},
	};

	create(document.body, options);

	setupTauriExternalOpener();
	setupMenuActions();
	setupWindowStateSave();
	setupNativeWindowDragging();

	console.log('[SideX] Workbench created' + (folderParam ? ` (folder: ${folderParam})` : ' (no folder)'), 'workspace:', workspace);
}

function setupTauriExternalOpener() {
	import('@tauri-apps/plugin-shell').then(shell => {
		(window as any).__sidex_shellOpen = (url: string) => {
			shell.open(url).catch(() => {});
		};
	}).catch(() => {});
}

function setupWindowStateSave() {
	import('@tauri-apps/api/core').then(({ invoke }) => {
		let saveTimer: ReturnType<typeof setTimeout> | null = null;
		const debouncedSave = () => {
			if (saveTimer) { clearTimeout(saveTimer); }
			saveTimer = setTimeout(() => {
				invoke('save_window_state', { label: 'main' }).catch(() => {});
			}, 500);
		};

		window.addEventListener('resize', debouncedSave);
		window.addEventListener('beforeunload', () => {
			invoke('save_window_state', { label: 'main' }).catch(() => {});
		});
	}).catch(() => {});
}

function setupNativeWindowDragging() {
	let appWindow: { startDragging(): Promise<void> } | null = null;
	import('@tauri-apps/api/window')
		.then(mod => { appWindow = mod.getCurrentWindow(); })
		.catch(() => {});

	document.addEventListener('mousedown', (e: MouseEvent) => {
		if (e.button !== 0 || !appWindow) {
			return;
		}
		const target = e.target as HTMLElement | null;
		if (!target?.closest('.part.titlebar')) {
			return;
		}
		if (target.closest('a, button, input, select, textarea, .action-item, .command-center, .window-controls-container')) {
			return;
		}
		if (target.closest('[draggable="true"]') || target.getAttribute('draggable') === 'true') {
			return;
		}
		appWindow.startDragging().catch(() => {});
	}, true);
}

function setupMenuActions() {
	const menuToCommand: Record<string, string> = {
		// File
		'new_file': 'workbench.action.files.newUntitledFile',
		'new_window': 'workbench.action.newWindow',
		'open_file': 'workbench.action.files.openFile',
		'open_folder': 'workbench.action.files.openFolder',
		'save': 'workbench.action.files.save',
		'save_as': 'workbench.action.files.saveAs',
		'save_all': 'workbench.action.files.saveAll',
		'close_editor': 'workbench.action.closeActiveEditor',
		'close_window': 'workbench.action.closeWindow',
		// Edit
		'find': 'actions.find',
		'replace': 'editor.action.startFindReplaceAction',
		'find_in_files': 'workbench.action.findInFiles',
		'replace_in_files': 'workbench.action.replaceInFiles',
		// Selection
		'expand_selection': 'editor.action.smartSelect.expand',
		'shrink_selection': 'editor.action.smartSelect.shrink',
		'copy_line_up': 'editor.action.copyLinesUpAction',
		'copy_line_down': 'editor.action.copyLinesDownAction',
		'move_line_up': 'editor.action.moveLinesUpAction',
		'move_line_down': 'editor.action.moveLinesDownAction',
		'add_cursor_above': 'editor.action.insertCursorAbove',
		'add_cursor_below': 'editor.action.insertCursorBelow',
		'select_all_occurrences': 'editor.action.selectHighlights',
		// View
		'command_palette': 'workbench.action.showCommands',
		'explorer': 'workbench.view.explorer',
		'search': 'workbench.view.search',
		'source_control': 'workbench.view.scm',
		'debug': 'workbench.view.debug',
		'extensions': 'workbench.view.extensions',
		'problems': 'workbench.actions.view.problems',
		'output': 'workbench.action.output.toggleOutput',
		'terminal': 'workbench.action.terminal.toggleTerminal',
		'debug_console': 'workbench.debug.action.toggleRepl',
		'toggle_fullscreen': 'workbench.action.toggleFullScreen',
		'zoom_in': 'workbench.action.zoomIn',
		'zoom_out': 'workbench.action.zoomOut',
		'reset_zoom': 'workbench.action.zoomReset',
		// Go
		'back': 'workbench.action.navigateBack',
		'forward': 'workbench.action.navigateForward',
		'go_to_file': 'workbench.action.quickOpen',
		'go_to_symbol': 'workbench.action.showAllSymbols',
		'go_to_line': 'workbench.action.gotoLine',
		'go_to_definition': 'editor.action.revealDefinition',
		'go_to_references': 'editor.action.goToReferences',
		// Run
		'start_debugging': 'workbench.action.debug.start',
		'run_without_debugging': 'workbench.action.debug.run',
		'stop_debugging': 'workbench.action.debug.stop',
		'restart_debugging': 'workbench.action.debug.restart',
		'toggle_breakpoint': 'editor.debug.action.toggleBreakpoint',
		// Terminal
		'new_terminal': 'workbench.action.terminal.new',
		'split_terminal': 'workbench.action.terminal.split',
		'run_task': 'workbench.action.tasks.runTask',
		'run_build_task': 'workbench.action.tasks.build',
		// Help
		'keyboard_shortcuts': 'workbench.action.keybindingsEditor',
	};

	(window as any).__sidex_menu_action = async (menuId: string) => {
		if (menuId === 'open_folder') {
			sidexOpenFolder();
			return;
		}

		if (menuId === 'find') {
			const editorService = (window as any).__sidex_editorService;
			if (editorService?.activeEditor?.typeId === 'workbench.editors.webviewInput') {
				try {
					await (window as any).__sidex_commandService?.executeCommand('editor.action.webvieweditor.showFind');
				} catch { }
				return;
			}
		}

		const commandId = menuToCommand[menuId];
		if (!commandId) {
			console.warn(`[SideX] Unknown menu action: ${menuId}`);
			return;
		}
		try {
			const event = new CustomEvent('sidex-command', { detail: { commandId } });
			window.dispatchEvent(event);
		} catch (e) {
			console.error(`[SideX] Failed to execute menu command ${commandId}:`, e);
		}
	};

	// Native menu events arrive as CustomEvents from the Rust backend
	window.addEventListener('sidex-native-menu', ((e: CustomEvent) => {
		const menuId = e.detail;
		if (typeof menuId === 'string' && (window as any).__sidex_menu_action) {
			(window as any).__sidex_menu_action(menuId);
		}
	}) as EventListener);

	// Listen for command execution via keyboard shortcuts forwarded from native menu
	window.addEventListener('sidex-command', async (e: any) => {
		const commandId = e.detail?.commandId;
		if (!commandId) return;
		if (commandId === 'workbench.action.files.openFolder' || commandId === 'workbench.action.files.openFolderViaWorkspace') {
			sidexOpenFolder();
			return;
		}
		try {
			const commandService = (window as any).__sidex_commandService;
			if (commandService) {
				await commandService.executeCommand(commandId);
			} else {
				console.warn(`[SideX] Command service not ready, queuing: ${commandId}`);
			}
		} catch (err) {
			console.error(`[SideX] Command ${commandId} failed:`, err);
		}
	});
}

boot().catch((err) => {
	console.error('[SideX] Fatal:', err);
	const container = document.createElement('div');
	container.style.cssText = 'padding:40px;color:#ccc;font-family:system-ui';
	const h2 = document.createElement('h2');
	h2.textContent = 'SideX failed to start';
	const pre = document.createElement('pre');
	pre.style.cssText = 'color:#f88;white-space:pre-wrap';
	pre.textContent = (err as Error)?.stack || String(err);
	container.append(h2, pre);
	document.body.replaceChildren(container);
});
