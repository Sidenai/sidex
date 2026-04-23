/*---------------------------------------------------------------------------------------------
 *  SideX — Tauri-based VSCode port
 *  Entry point. Globals set by inline script in index.html.
 *--------------------------------------------------------------------------------------------*/

// --- Global crash handler: catches ALL unhandled errors ---
window.addEventListener('error', (event) => {
	console.error('[SideX CRASH] Uncaught error:', event.error?.message || event.message, '\n', event.error?.stack || `at ${event.filename}:${event.lineno}:${event.colno}`);
});
window.addEventListener('unhandledrejection', (event) => {
	const reason = event.reason;
	console.error('[SideX CRASH] Unhandled promise rejection:', reason?.message || reason, '\n', reason?.stack || '(no stack)');
});

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
	console.error('[SideX DEBUG] navigateToFolder called with:', folderUri);
	const url = new URL(window.location.href);
	url.searchParams.set('folder', folderUri);
	console.error('[SideX DEBUG] Navigating to:', url.toString());
	window.location.href = url.toString();
}

async function boot() {
	// Load locale translations before any VS Code module imports
	await loadNlsMessages();

	await Promise.all([
		import('./vs/workbench/workbench.common.main.js').catch(e => {
			console.error('[SideX] Barrel "common" failed:', e);
			throw e;
		}),
		import('./vs/workbench/browser/web.main.js').catch(e => {
			console.error('[SideX] Barrel "web.main" failed:', e);
			throw e;
		}),
		import('./vs/workbench/browser/parts/dialogs/dialog.web.contribution.js').catch(e => {
			console.error('[SideX] Barrel "web-dialog" failed:', e);
			throw e;
		}),
		import('./vs/workbench/workbench.web.main.js').catch(e => {
			console.error('[SideX] Barrel "web-services" failed:', e);
			throw e;
		})
	]);

	// SideX Rust bridge initialization — make services available before workbench creation
	if ((globalThis as any).__SIDEX_TAURI__) {
		const {
			SideXEditorBridge,
			SideXSyntaxService,
			SideXGitService,
			SideXSearchService,
			SideXSettingsService,
			SideXThemeService,
			SideXExtensionService,
			SideXKeymapService,
			SideXFileSystemProvider
		} = await import('./vs/platform/sidex/common/sidexServices.js');

		(globalThis as any).__SIDEX_SERVICES__ = {
			editor: SideXEditorBridge.getInstance(),
			syntax: new SideXSyntaxService(),
			git: new SideXGitService(),
			search: new SideXSearchService(),
			settings: new SideXSettingsService(),
			theme: new SideXThemeService(),
			extensions: new SideXExtensionService(),
			keymap: new SideXKeymapService(),
			fileSystem: new SideXFileSystemProvider()
		};

		console.log('[SideX] Rust bridge services initialized');
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
			themeType: 'dark'
		},

		additionalTrustedDomains: ['https://github.com', 'https://*.github.com', 'https://*.githubusercontent.com'],

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
			}
		},
		windowIndicator: {
			label: folderParam ? decodeURIComponent(folderParam.split('/').pop() || 'SideX') : 'SideX',
			tooltip: 'SideX — Tauri Code Editor',
			command: undefined
		},
		productConfiguration: {
			nameShort: 'SideX',
			nameLong: 'SideX',
			applicationName: 'sidex',
			dataFolderName: '.sidex',
			version: '1.110.0',
			linkProtectionTrustedDomains: ['https://github.com', 'https://*.github.com', 'https://*.githubusercontent.com']
		},
		settingsSyncOptions: {
			enabled: false
		},
		additionalBuiltinExtensions: [],
		configurationDefaults: {
			// --- Sidex identity ---
			'workbench.startupEditor': 'welcomePage',
			'workbench.enableExperiments': false,
			'workbench.iconTheme': 'vs-seti',
			'workbench.colorTheme': 'Default Dark+',
			'editor.experimentalGpuAcceleration': 'auto',
			'workbench.productIconTheme': 'Default',

			// --- Sidex layout defaults ---
			'workbench.activityBar.location': 'default',
			'workbench.activityBar.compact': false,
			'workbench.statusBar.visible': true,
			'workbench.editor.showTabs': 'multiple',
			'workbench.editor.enablePreview': false,
			'workbench.editor.tabCloseButton': 'right',
			'workbench.editor.tabSizing': 'fit',
			'workbench.editor.highlightModifiedTabs': true,
			'workbench.list.smoothScrolling': true,
			'workbench.tree.renderIndentGuides': 'always',

			// --- Window & chrome ---
			'window.titleBarStyle': 'custom',
			'window.menuBarVisibility': navigator.userAgent.includes('Mac') ? 'hidden' : 'classic',
			'window.commandCenter': true,
			'breadcrumbs.enabled': false,

			// --- Editor: keep VSCode defaults, only change chrome-level settings ---
			'editor.minimap.enabled': false,
			'editor.stickyScroll.enabled': false,
			'editor.smoothScrolling': true,
			'editor.cursorBlinking': 'smooth',
			'editor.cursorSmoothCaretAnimation': 'on',
			'editor.bracketPairColorization.enabled': true,
			'editor.guides.bracketPairs': true,
			'editor.linkedEditing': true,
			'editor.suggest.showStatusBar': true,
			'editor.inlineSuggest.enabled': true,

			// --- Terminal ---
			'terminal.integrated.smoothScrolling': true,
			'terminal.integrated.enablePersistentSessions': false,
			'terminal.integrated.defaultProfile.osx': 'zsh',
			'terminal.integrated.defaultProfile.linux': 'bash',
			'terminal.integrated.profiles.osx': {
				zsh: { path: 'zsh', args: ['-l'] },
				bash: { path: 'bash', args: ['-l'], icon: 'terminal-bash' },
				fish: { path: 'fish', args: ['-l'] },
				tmux: { path: 'tmux', icon: 'terminal-tmux' },
				pwsh: { path: 'pwsh', icon: 'terminal-powershell' }
			},
			'terminal.integrated.profiles.linux': {
				bash: { path: 'bash', args: ['-l'], icon: 'terminal-bash' },
				zsh: { path: 'zsh', args: ['-l'] },
				fish: { path: 'fish', args: ['-l'] },
				tmux: { path: 'tmux', icon: 'terminal-tmux' },
				pwsh: { path: 'pwsh', icon: 'terminal-powershell' }
			},

			// --- SCM & extensions ---
			'scm.defaultViewMode': 'list',
			'extensions.autoUpdate': false,
			'extensions.autoCheckUpdates': false,
			'extensions.autoRestart': true,

			// --- Disable VSCode-specific features ---
			'telemetry.telemetryLevel': 'off',
			'update.mode': 'none',
			'update.showReleaseNotes': false,
			'workbench.settings.enableNaturalLanguageSearch': false,
			'chat.editor.enabled': false,
			'chat.commandCenter.enabled': false,
			'security.workspace.trust.startupPrompt': 'never',
			'security.workspace.trust.banner': 'never',
			'security.workspace.trust.enabled': false
		}
	};

	console.error('[SideX DEBUG] About to call create(document.body, options)');
	create(document.body, options);
	console.error('[SideX DEBUG] create() completed successfully');
	setupTauriExternalOpener();
	setupMenuActions();
	setupWindowStateSave();
	setupNativeWindowDragging();
	updateNativeMenuLabels();

	console.log(
		'[SideX] Workbench created' + (folderParam ? ` (folder: ${folderParam})` : ' (no folder)'),
		'workspace:',
		workspace
	);
}

function setupTauriExternalOpener() {
	import('@tauri-apps/plugin-shell')
		.then(shell => {
			(window as any).__sidex_shellOpen = (url: string) => {
				shell.open(url).catch(() => {});
			};
		})
		.catch(() => {});
}

function setupWindowStateSave() {
	import('@tauri-apps/api/core')
		.then(({ invoke }) => {
			let saveTimer: ReturnType<typeof setTimeout> | null = null;
			const debouncedSave = () => {
				if (saveTimer) {
					clearTimeout(saveTimer);
				}
				saveTimer = setTimeout(() => {
					invoke('save_window_state', { label: 'main' }).catch(() => {});
				}, 500);
			};

			window.addEventListener('resize', debouncedSave);
			window.addEventListener('beforeunload', () => {
				invoke('save_window_state', { label: 'main' }).catch(() => {});
			});
		})
		.catch(() => {});
}

function setupNativeWindowDragging() {
	let appWindow: { startDragging(): Promise<void> } | null = null;
	import('@tauri-apps/api/window')
		.then(mod => {
			appWindow = mod.getCurrentWindow();
		})
		.catch(() => {});

	document.addEventListener(
		'mousedown',
		(e: MouseEvent) => {
			if (e.button !== 0 || !appWindow) {
				return;
			}
			const target = e.target as HTMLElement | null;
			if (!target?.closest('.part.titlebar')) {
				return;
			}
			if (
				target.closest('a, button, input, select, textarea, .action-item, .command-center, .window-controls-container')
			) {
				return;
			}
			if (target.closest('[draggable="true"]') || target.getAttribute('draggable') === 'true') {
				return;
			}
			appWindow.startDragging().catch(() => {});
		},
		true
	);
}

function setupMenuActions() {
	const menuToCommand: Record<string, string> = {
		// File
		new_file: 'workbench.action.files.newUntitledFile',
		new_window: 'workbench.action.newWindow',
		open_file: 'workbench.action.files.openFile',
		open_folder: 'workbench.action.files.openFolder',
		save: 'workbench.action.files.save',
		save_as: 'workbench.action.files.saveAs',
		save_all: 'workbench.action.files.saveAll',
		close_editor: 'workbench.action.closeActiveEditor',
		close_window: 'workbench.action.closeWindow',
		// Edit
		find: 'actions.find',
		replace: 'editor.action.startFindReplaceAction',
		find_in_files: 'workbench.action.findInFiles',
		replace_in_files: 'workbench.action.replaceInFiles',
		// Selection
		expand_selection: 'editor.action.smartSelect.expand',
		shrink_selection: 'editor.action.smartSelect.shrink',
		copy_line_up: 'editor.action.copyLinesUpAction',
		copy_line_down: 'editor.action.copyLinesDownAction',
		move_line_up: 'editor.action.moveLinesUpAction',
		move_line_down: 'editor.action.moveLinesDownAction',
		add_cursor_above: 'editor.action.insertCursorAbove',
		add_cursor_below: 'editor.action.insertCursorBelow',
		select_all_occurrences: 'editor.action.selectHighlights',
		// View
		command_palette: 'workbench.action.showCommands',
		explorer: 'workbench.view.explorer',
		search: 'workbench.view.search',
		source_control: 'workbench.view.scm',
		debug: 'workbench.view.debug',
		extensions: 'workbench.view.extensions',
		problems: 'workbench.actions.view.problems',
		output: 'workbench.action.output.toggleOutput',
		terminal: 'workbench.action.terminal.toggleTerminal',
		debug_console: 'workbench.debug.action.toggleRepl',
		toggle_fullscreen: 'workbench.action.toggleFullScreen',
		zoom_in: 'workbench.action.zoomIn',
		zoom_out: 'workbench.action.zoomOut',
		reset_zoom: 'workbench.action.zoomReset',
		// Go
		back: 'workbench.action.navigateBack',
		forward: 'workbench.action.navigateForward',
		go_to_file: 'workbench.action.quickOpen',
		go_to_symbol: 'workbench.action.showAllSymbols',
		go_to_line: 'workbench.action.gotoLine',
		go_to_definition: 'editor.action.revealDefinition',
		go_to_references: 'editor.action.goToReferences',
		// Run
		start_debugging: 'workbench.action.debug.start',
		run_without_debugging: 'workbench.action.debug.run',
		stop_debugging: 'workbench.action.debug.stop',
		restart_debugging: 'workbench.action.debug.restart',
		toggle_breakpoint: 'editor.debug.action.toggleBreakpoint',
		// Terminal
		new_terminal: 'workbench.action.terminal.new',
		split_terminal: 'workbench.action.terminal.split',
		run_task: 'workbench.action.tasks.runTask',
		run_build_task: 'workbench.action.tasks.build',
		// Help
		keyboard_shortcuts: 'workbench.action.keybindingsEditor'
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
				} catch {}
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
		if (!commandId) {
			return;
		}
		if (
			commandId === 'workbench.action.files.openFolder' ||
			commandId === 'workbench.action.files.openFolderViaWorkspace'
		) {
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

/**
 * After NLS translations are loaded into `_VSCODE_NLS_MESSAGES`, send
 * translated labels to the Rust side so the native macOS menu bar updates.
 */
async function updateNativeMenuLabels() {
	if (!navigator.userAgent.includes('Mac')) {
		return;
	}

	const nlsMessages: string[] | undefined = (globalThis as any)._VSCODE_NLS_MESSAGES;
	if (!nlsMessages) {
		return;
	}

	// NLS key -> native menu item ID.
	// Submenu headers use the submenu IDs from lib.rs; individual items use
	// the MenuItemBuilder IDs.  Keys come from menubarControl.ts / the
	// various contribution files.
	const nlsKeyToMenuId: Record<string, string> = {
		// Submenu titles
		mFile: 'file_menu',
		mEdit: 'edit_menu',
		mSelection: 'selection_menu',
		mView: 'view_menu',
		mGoto: 'go_menu',
		mRun: 'run_menu',
		mTerminal: 'terminal_menu',
		mHelp: 'help_menu',
		// File menu items
		miNewFile: 'new_file',
		miNewWindow: 'new_window',
		miOpenFile: 'open_file',
		miSave: 'save',
		miSaveAs: 'save_as',
		miCloseEditor: 'close_editor',
		// Edit menu items
		miFind: 'find',
		miReplace: 'replace',
		miFindInFiles: 'find_in_files',
		miReplaceInFiles: 'replace_in_files',
		// View menu items
		miCommandPalette: 'command_palette',
		miToggleFullScreen: 'toggle_fullscreen',
		miZoomIn: 'zoom_in',
		miZoomOut: 'zoom_out',
		miZoomReset: 'reset_zoom',
		// Go menu items
		miBack: 'back',
		miForward: 'forward',
		miGotoFile: 'go_to_file',
		miGotoSymbolInWorkspace: 'go_to_symbol',
		miGotoLine: 'go_to_line',
		miGotoDefinition: 'go_to_definition',
		// Run menu items
		miStartDebugging: 'start_debugging',
		miRunWithoutDebugging: 'run_without_debugging',
		miStopDebugging: 'stop_debugging',
		miRestartDebugging: 'restart_debugging',
		miToggleBreakpoint: 'toggle_breakpoint',
		// Terminal menu items
		miNewTerminal: 'new_terminal',
		miSplitTerminal: 'split_terminal',
		miRunTask: 'run_task',
		miRunBuildTask: 'run_build_task',
		// Help menu items
		miWelcome: 'welcome',
		miDocumentation: 'documentation',
		miReleaseNotes: 'release_notes',
		miKeyboardShortcuts: 'keyboard_shortcuts',
		miReportIssue: 'report_issue'
	};

	try {
		const indexRes = await fetch('/nls.messages.json');
		if (!indexRes.ok) {
			return;
		}
		const nlsEntries: Array<{ key: string; msg: string }> = await indexRes.json();

		const labels: Record<string, string> = {};

		for (let i = 0; i < nlsEntries.length; i++) {
			const menuId = nlsKeyToMenuId[nlsEntries[i].key];
			if (menuId) {
				const translated = nlsMessages[i];
				if (typeof translated === 'string' && translated !== nlsEntries[i].msg) {
					labels[menuId] = translated.replace(/&&/g, '').replace(/&/g, '');
				}
			}
		}

		if (Object.keys(labels).length === 0) {
			return;
		}

		const { invoke } = await import('@tauri-apps/api/core');
		await invoke('update_menu_labels', { labels });
	} catch (e) {
		console.warn('[SideX] Could not update native menu labels:', e);
	}
}

boot().catch(err => {
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
