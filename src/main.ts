/*---------------------------------------------------------------------------------------------
 *  SideX — Tauri-based VSCode port
 *  Entry point. Globals set by inline script in index.html.
 *--------------------------------------------------------------------------------------------*/

async function boot() {
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
			console.warn(`[SideX] Barrel stage "${label}" failed (non-fatal):`, e);
		}
	}

	const { create } = await import('./vs/workbench/browser/web.factory.js');
	const { URI } = await import('./vs/base/common/uri.js');

	if (document.readyState === 'loading') {
		await new Promise<void>(r => window.addEventListener('DOMContentLoaded', () => r()));
	}

	const urlParams = new URLSearchParams(window.location.search);
	const folderParam = urlParams.get('folder');

	// Build the workspace provider — this is how VSCode web knows what folder to open
	let workspace: any = undefined;
	if (folderParam) {
		workspace = { folderUri: URI.parse(folderParam) };
	}

	const options: any = {
		// The workspace provider tells VSCode what folder/workspace to open
		workspaceProvider: {
			workspace,
			trusted: true,
			open: async (_workspace: any, _options: any) => {
				// When VSCode asks to open a new workspace, reload with the folder param
				if (_workspace && 'folderUri' in _workspace) {
					const url = new URL(window.location.href);
					url.searchParams.set('folder', _workspace.folderUri.toString());
					window.location.href = url.toString();
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
			version: '0.1.0',
		},
		settingsSyncOptions: {
			enabled: false,
		},
		additionalBuiltinExtensions: [],
		defaultLayout: {
			editors: [],
			layout: { editors: {} },
		},
		configurationDefaults: {
			'workbench.startupEditor': 'none',
			'workbench.enableExperiments': false,
			'window.menuBarVisibility': 'hidden',
			'window.titleBarStyle': 'custom',
			'window.commandCenter': true,
			'telemetry.telemetryLevel': 'off',
			'update.mode': 'none',
			'extensions.autoUpdate': false,
			'extensions.autoCheckUpdates': false,
			'workbench.settings.enableNaturalLanguageSearch': false,
		},
	};

	create(document.body, options);

	// Wire up native macOS menu actions → VSCode commands
	setupMenuActions();

	console.log('[SideX] Workbench created' + (folderParam ? ` (folder: ${folderParam})` : ' (no folder)'), 'workspace:', workspace);
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
		'toggle_dev_tools': 'workbench.action.toggleDevTools',
	};

	(window as any).__sidex_menu_action = async (menuId: string) => {
		const commandId = menuToCommand[menuId];
		if (!commandId) {
			console.warn(`[SideX] Unknown menu action: ${menuId}`);
			return;
		}
		try {
			const { CommandsRegistry } = await import('./vs/platform/commands/common/commands.js');
			// Access the global command service through the workbench
			const event = new CustomEvent('sidex-command', { detail: { commandId } });
			window.dispatchEvent(event);
		} catch (e) {
			console.error(`[SideX] Failed to execute menu command ${commandId}:`, e);
		}
	};

	// Listen for command execution via keyboard shortcuts forwarded from native menu
	window.addEventListener('sidex-command', async (e: any) => {
		const commandId = e.detail?.commandId;
		if (!commandId) return;
		try {
			// Use the keybinding dispatch trick — simulate the keyboard shortcut
			// or directly invoke the command if the service is available
			const commandService = (window as any).__sidex_commandService;
			if (commandService) {
				await commandService.executeCommand(commandId);
			} else {
				console.warn(`[SideX] Command service not ready, queuing: ${commandId}`);
			}
		} catch (e) {
			console.error(`[SideX] Command ${commandId} failed:`, e);
		}
	});
}

boot().catch((err) => {
	console.error('[SideX] Fatal:', err);
	document.body.innerHTML = `<div style="padding:40px;color:#ccc;font-family:system-ui">
		<h2>SideX failed to start</h2>
		<pre style="color:#f88;white-space:pre-wrap">${(err as Error)?.stack || err}</pre>
	</div>`;
});
