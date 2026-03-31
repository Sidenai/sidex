/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { addUNCHostToAllowlist, disableUNCAccessRestrictions } from '../../base/node/unc.js';
import { validatedIpcMain } from '../../base/parts/ipc/electron-main/ipcMain.js';
import { hostname, release } from 'os';
import { initWindowsVersionInfo } from '../../base/node/windowsVersion.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { toErrorMessage } from '../../base/common/errorMessage.js';
import { Event } from '../../base/common/event.js';
import { parse } from '../../base/common/jsonc.js';
import { getPathLabel } from '../../base/common/labels.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../base/common/lifecycle.js';
import { Schemas, VSCODE_AUTHORITY } from '../../base/common/network.js';
import { join, posix } from '../../base/common/path.js';
import { INodeProcess, IProcessEnvironment, isLinux, isLinuxSnap, isMacintosh, isWindows, OS } from '../../base/common/platform.js';
import { assertType } from '../../base/common/types.js';
import { URI } from '../../base/common/uri.js';
import { generateUuid } from '../../base/common/uuid.js';
import { registerContextMenuListener } from '../../base/parts/contextmenu/electron-main/contextmenu.js';
import { getDelayedChannel, ProxyChannel, StaticRouter } from '../../base/parts/ipc/common/ipc.js';
import { Server as ElectronIPCServer } from '../../base/parts/ipc/electron-main/ipc.electron.js';
import { Client as MessagePortClient } from '../../base/parts/ipc/electron-main/ipc.mp.js';
import { Server as NodeIPCServer } from '../../base/parts/ipc/node/ipc.net.js';
import { IProxyAuthService, ProxyAuthService } from '../../platform/native/electron-main/auth.js';
import { localize } from '../../nls.js';
import { IBackupMainService } from '../../platform/backup/electron-main/backup.js';
import { BackupMainService } from '../../platform/backup/electron-main/backupMainService.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ElectronExtensionHostDebugBroadcastChannel } from '../../platform/debug/electron-main/extensionHostDebugIpc.js';
import { IDiagnosticsService } from '../../platform/diagnostics/common/diagnostics.js';
import { DiagnosticsMainService, IDiagnosticsMainService } from '../../platform/diagnostics/electron-main/diagnosticsMainService.js';
import { DialogMainService, IDialogMainService } from '../../platform/dialogs/electron-main/dialogMainService.js';
import { IEncryptionMainService } from '../../platform/encryption/common/encryptionService.js';
import { EncryptionMainService } from '../../platform/encryption/electron-main/encryptionMainService.js';
import { NativeBrowserElementsMainService, INativeBrowserElementsMainService } from '../../platform/browserElements/electron-main/nativeBrowserElementsMainService.js';
import { ipcBrowserViewChannelName } from '../../platform/browserView/common/browserView.js';
import { ipcBrowserViewGroupChannelName } from '../../platform/browserView/common/browserViewGroup.js';
import { BrowserViewMainService, IBrowserViewMainService } from '../../platform/browserView/electron-main/browserViewMainService.js';
import { BrowserViewGroupMainService, IBrowserViewGroupMainService } from '../../platform/browserView/electron-main/browserViewGroupMainService.js';
import { NativeParsedArgs } from '../../platform/environment/common/argv.js';
import { IEnvironmentMainService } from '../../platform/environment/electron-main/environmentMainService.js';
import { isLaunchedFromCli } from '../../platform/environment/node/argvHelper.js';
import { getResolvedShellEnv } from '../../platform/shell/node/shellEnv.js';
import { IExtensionHostStarter, ipcExtensionHostStarterChannelName } from '../../platform/extensions/common/extensionHostStarter.js';
import { ExtensionHostStarter } from '../../platform/extensions/electron-main/extensionHostStarter.js';
import { IExternalTerminalMainService } from '../../platform/externalTerminal/electron-main/externalTerminal.js';
import { LinuxExternalTerminalService, MacExternalTerminalService, WindowsExternalTerminalService } from '../../platform/externalTerminal/node/externalTerminalService.js';
import { ISandboxHelperMainService } from '../../platform/sandbox/electron-main/sandboxHelperService.js';
import { SandboxHelperService } from '../../platform/sandbox/node/sandboxHelper.js';
import { LOCAL_FILE_SYSTEM_CHANNEL_NAME } from '../../platform/files/common/diskFileSystemProviderClient.js';
import { IFileService } from '../../platform/files/common/files.js';
import { DiskFileSystemProviderChannel } from '../../platform/files/electron-main/diskFileSystemProviderServer.js';
import { DiskFileSystemProvider } from '../../platform/files/node/diskFileSystemProvider.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { ProcessMainService } from '../../platform/process/electron-main/processMainService.js';
import { IKeyboardLayoutMainService, KeyboardLayoutMainService } from '../../platform/keyboardLayout/electron-main/keyboardLayoutMainService.js';
import { ILaunchMainService, LaunchMainService } from '../../platform/launch/electron-main/launchMainService.js';
import { ILifecycleMainService, LifecycleMainPhase, ShutdownReason } from '../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILoggerService, ILogService } from '../../platform/log/common/log.js';
import { IMenubarMainService, MenubarMainService } from '../../platform/menubar/electron-main/menubarMainService.js';
import { INativeHostMainService, NativeHostMainService } from '../../platform/native/electron-main/nativeHostMainService.js';
import { IMeteredConnectionService } from '../../platform/meteredConnection/common/meteredConnection.js';
import { METERED_CONNECTION_CHANNEL } from '../../platform/meteredConnection/common/meteredConnectionIpc.js';
import { MeteredConnectionChannel } from '../../platform/meteredConnection/electron-main/meteredConnectionChannel.js';
import { MeteredConnectionMainService } from '../../platform/meteredConnection/electron-main/meteredConnectionMainService.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { getRemoteAuthority } from '../../platform/remote/common/remoteHosts.js';
import { SharedProcess } from '../../platform/sharedProcess/electron-main/sharedProcess.js';
import { ISignService } from '../../platform/sign/common/sign.js';
import { IStateService } from '../../platform/state/node/state.js';
import { StorageDatabaseChannel } from '../../platform/storage/electron-main/storageIpc.js';
import { ApplicationStorageMainService, IApplicationStorageMainService, IStorageMainService, StorageMainService } from '../../platform/storage/electron-main/storageMainService.js';
import { resolveCommonProperties } from '../../platform/telemetry/common/commonProperties.js';
import { ITelemetryService, TelemetryLevel } from '../../platform/telemetry/common/telemetry.js';
import { TelemetryAppenderClient } from '../../platform/telemetry/common/telemetryIpc.js';
import { ITelemetryServiceConfig, TelemetryService } from '../../platform/telemetry/common/telemetryService.js';
import { getPiiPathsFromEnvironment, getTelemetryLevel, isInternalTelemetry, NullTelemetryService, supportsTelemetry } from '../../platform/telemetry/common/telemetryUtils.js';
import { IUpdateService } from '../../platform/update/common/update.js';
import { UpdateChannel } from '../../platform/update/common/updateIpc.js';
import { DarwinUpdateService } from '../../platform/update/electron-main/updateService.darwin.js';
import { LinuxUpdateService } from '../../platform/update/electron-main/updateService.linux.js';
import { SnapUpdateService } from '../../platform/update/electron-main/updateService.snap.js';
import { Win32UpdateService } from '../../platform/update/electron-main/updateService.win32.js';
import { IOpenURLOptions, IURLService } from '../../platform/url/common/url.js';
import { URLHandlerChannelClient, URLHandlerRouter } from '../../platform/url/common/urlIpc.js';
import { NativeURLService } from '../../platform/url/common/urlService.js';
import { ElectronURLListener } from '../../platform/url/electron-main/electronUrlListener.js';
import { IWebviewManagerService } from '../../platform/webview/common/webviewManagerService.js';
import { WebviewMainService } from '../../platform/webview/electron-main/webviewMainService.js';
import { isFolderToOpen, isWorkspaceToOpen, IWindowOpenable } from '../../platform/window/common/window.js';
import { getAllWindowsExcludingOffscreen, IWindowsMainService, OpenContext } from '../../platform/windows/electron-main/windows.js';
import { ICodeWindow } from '../../platform/window/electron-main/window.js';
import { WindowsMainService } from '../../platform/windows/electron-main/windowsMainService.js';
import { ActiveWindowManager } from '../../platform/windows/node/windowTracker.js';
import { hasWorkspaceFileExtension } from '../../platform/workspace/common/workspace.js';
import { IWorkspacesService } from '../../platform/workspaces/common/workspaces.js';
import { IWorkspacesHistoryMainService, WorkspacesHistoryMainService } from '../../platform/workspaces/electron-main/workspacesHistoryMainService.js';
import { WorkspacesMainService } from '../../platform/workspaces/electron-main/workspacesMainService.js';
import { IWorkspacesManagementMainService, WorkspacesManagementMainService } from '../../platform/workspaces/electron-main/workspacesManagementMainService.js';
import { IPolicyService } from '../../platform/policy/common/policy.js';
import { PolicyChannel } from '../../platform/policy/common/policyIpc.js';
import { IUserDataProfilesMainService } from '../../platform/userDataProfile/electron-main/userDataProfile.js';
import { IExtensionsProfileScannerService } from '../../platform/extensionManagement/common/extensionsProfileScannerService.js';
import { IExtensionsScannerService } from '../../platform/extensionManagement/common/extensionsScannerService.js';
import { ExtensionsScannerService } from '../../platform/extensionManagement/node/extensionsScannerService.js';
import { UserDataProfilesHandler } from '../../platform/userDataProfile/electron-main/userDataProfilesHandler.js';
import { ProfileStorageChangesListenerChannel } from '../../platform/userDataProfile/electron-main/userDataProfileStorageIpc.js';
import { Promises, RunOnceScheduler, runWhenGlobalIdle } from '../../base/common/async.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { resolveMachineId, resolveSqmId, resolveDevDeviceId, validateDevDeviceId } from '../../platform/telemetry/electron-main/telemetryUtils.js';
import { ExtensionsProfileScannerService } from '../../platform/extensionManagement/node/extensionsProfileScannerService.js';
import { LoggerChannel } from '../../platform/log/electron-main/logIpc.js';
import { ILoggerMainService } from '../../platform/log/electron-main/loggerService.js';
import { IInitialProtocolUrls, IProtocolUrl } from '../../platform/url/electron-main/url.js';
import { IUtilityProcessWorkerMainService, UtilityProcessWorkerMainService } from '../../platform/utilityProcess/electron-main/utilityProcessWorkerMainService.js';
import { ipcUtilityProcessWorkerChannelName } from '../../platform/utilityProcess/common/utilityProcessWorkerService.js';
import { ILocalPtyService, LocalReconnectConstants, TerminalIpcChannels, TerminalSettingId } from '../../platform/terminal/common/terminal.js';
import { ElectronPtyHostStarter } from '../../platform/terminal/electron-main/electronPtyHostStarter.js';
import { PtyHostService } from '../../platform/terminal/node/ptyHostService.js';
import { ElectronAgentHostStarter } from '../../platform/agentHost/electron-main/electronAgentHostStarter.js';
import { AgentHostProcessManager } from '../../platform/agentHost/node/agentHostService.js';
import { AgentHostEnabledSettingId } from '../../platform/agentHost/common/agentService.js';
import { NODE_REMOTE_RESOURCE_CHANNEL_NAME, NODE_REMOTE_RESOURCE_IPC_METHOD_NAME, NodeRemoteResourceResponse, NodeRemoteResourceRouter } from '../../platform/remote/common/electronRemoteResources.js';
import { Lazy } from '../../base/common/lazy.js';
import { IAuxiliaryWindowsMainService } from '../../platform/auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { AuxiliaryWindowsMainService } from '../../platform/auxiliaryWindow/electron-main/auxiliaryWindowsMainService.js';
import { normalizeNFC } from '../../base/common/normalization.js';
import { ICSSDevelopmentService, CSSDevelopmentService } from '../../platform/cssDev/node/cssDevService.js';
import { INativeMcpDiscoveryHelperService, NativeMcpDiscoveryHelperChannelName } from '../../platform/mcp/common/nativeMcpDiscoveryHelper.js';
import { NativeMcpDiscoveryHelperService } from '../../platform/mcp/node/nativeMcpDiscoveryHelperService.js';
import { IMcpGatewayService, McpGatewayChannelName } from '../../platform/mcp/common/mcpGateway.js';
import { McpGatewayService } from '../../platform/mcp/node/mcpGatewayService.js';
import { McpGatewayChannel } from '../../platform/mcp/node/mcpGatewayChannel.js';
import { IWebContentExtractorService } from '../../platform/webContentExtractor/common/webContentExtractor.js';
import { NativeWebContentExtractorService } from '../../platform/webContentExtractor/electron-main/webContentExtractorService.js';
import ErrorTelemetry from '../../platform/telemetry/electron-main/errorTelemetry.js';

/**
 * The main VS Code application. There will only ever be one instance,
 * even if the user starts many instances (e.g. from the command line).
 */
export class CodeApplication extends Disposable {

	private static readonly SECURITY_PROTOCOL_HANDLING_CONFIRMATION_SETTING_KEY = {
		[Schemas.file]: 'security.promptForLocalFileProtocolHandling' as const,
		[Schemas.vscodeRemote]: 'security.promptForRemoteFileProtocolHandling' as const
	};

	private windowsMainService: IWindowsMainService | undefined;
	private auxiliaryWindowsMainService: IAuxiliaryWindowsMainService | undefined;
	private nativeHostMainService: INativeHostMainService | undefined;

	constructor(
		private readonly mainProcessNodeIpcServer: NodeIPCServer,
		private readonly userEnv: IProcessEnvironment,
		@IInstantiationService private readonly mainInstantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@ILoggerService private readonly loggerService: ILoggerService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStateService private readonly stateService: IStateService,
		@IFileService private readonly fileService: IFileService,
		@IProductService private readonly productService: IProductService,
		@IUserDataProfilesMainService private readonly userDataProfilesMainService: IUserDataProfilesMainService
	) {
		super();

		this.configureSession();
		this.registerListeners();
	}

	private configureSession(): void {
		// Permission handling via Rust backend
		invoke('configure_session_permissions').catch(err =>
			this.logService.error('Failed to configure session permissions:', err)
		);

		// UNC Host Allowlist (Windows)
		if (isWindows) {
			if (this.configurationService.getValue('security.restrictUNCAccess') === false) {
				disableUNCAccessRestrictions();
			} else {
				addUNCHostToAllowlist(this.configurationService.getValue('security.allowedUNCHosts'));
			}
		}
	}

	private registerListeners(): void {
		Event.once(this.lifecycleMainService.onWillShutdown)(() => this.dispose());

		registerContextMenuListener();

		// Accessibility change via Tauri
		tauriListen<boolean>('tauri://accessibility-support-changed', (event) => {
			this.windowsMainService?.sendToAll('vscode:accessibilitySupportChanged', event.payload);
		}).catch(() => {});

		// macOS dock activate
		tauriListen<{ hasVisibleWindows: boolean }>('tauri://activate', async (event) => {
			this.logService.trace('app#activate');
			if (!event.payload.hasVisibleWindows) {
				if ((process as INodeProcess).isEmbeddedApp || (this.environmentMainService.args['agents'] && this.productService.quality !== 'stable')) {
					await this.windowsMainService?.openAgentsWindow({ context: OpenContext.DOCK });
				} else {
					await this.windowsMainService?.openEmptyWindow({ context: OpenContext.DOCK });
				}
			}
		}).catch(() => {});

		// Web contents created - delegate to auxiliary window service
		tauriListen<{ url: string; contentsId: number }>('tauri://web-contents-created', (event) => {
			const { url, contentsId } = event.payload;
			if (url?.startsWith(`${Schemas.vscodeFileResource}://${VSCODE_AUTHORITY}/`)) {
				this.logService.trace('[aux window] registering auxiliary window');
				// Auxiliary window registration handled via invoke
				invoke('register_auxiliary_window', { contentsId }).catch(() => {});
			}
		}).catch(() => {});

		// macOS open-file
		let macOpenFileURIs: IWindowOpenable[] = [];
		let runningTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
		tauriListen<{ path: string }>('tauri://file-drop', (event) => {
			let path = normalizeNFC(event.payload.path);
			this.logService.trace('app#open-file: ', path);

			macOpenFileURIs.push(hasWorkspaceFileExtension(path) ? { workspaceUri: URI.file(path) } : { fileUri: URI.file(path) });

			if (runningTimeout !== undefined) {
				clearTimeout(runningTimeout);
				runningTimeout = undefined;
			}

			runningTimeout = setTimeout(async () => {
				await this.windowsMainService?.open({
					context: OpenContext.DOCK,
					cli: this.environmentMainService.args,
					urisToOpen: macOpenFileURIs,
					gotoLineMode: false,
					preferNewWindow: true
				});
				macOpenFileURIs = [];
				runningTimeout = undefined;
			}, 100);
		}).catch(() => {});

		tauriListen('tauri://new-window-for-tab', async () => {
			await this.windowsMainService?.openEmptyWindow({ context: OpenContext.DESKTOP });
		}).catch(() => {});

		//#region Bootstrap IPC Handlers
		validatedIpcMain.handle('vscode:fetchShellEnv', event => {
			const window = this.windowsMainService?.getWindowByWebContents(event.sender);
			let args: NativeParsedArgs;
			let env: IProcessEnvironment;
			if (window?.config) {
				args = window.config;
				env = { ...process.env, ...window.config.userEnv };
			} else {
				args = this.environmentMainService.args;
				env = process.env;
			}
			return this.resolveShellEnvironment(args, env, false);
		});

		validatedIpcMain.on('vscode:toggleDevTools', event => event.sender.toggleDevTools());
		validatedIpcMain.on('vscode:openDevTools', event => event.sender.openDevTools());
		validatedIpcMain.on('vscode:reloadWindow', event => event.sender.reload());

		validatedIpcMain.handle('vscode:notifyZoomLevel', async (event, zoomLevel: number | undefined) => {
			const window = this.windowsMainService?.getWindowByWebContents(event.sender);
			if (window) { window.notifyZoomLevel(zoomLevel); }
		});
		//#endregion
	}

	async startup(): Promise<void> {
		this.logService.debug('Starting VS Code');
		this.logService.debug(`from: ${this.environmentMainService.appRoot}`);
		this.logService.debug('args:', this.environmentMainService.args);

		// App user model id (Windows)
		const win32AppUserModelId = this.productService.win32AppUserModelId;
		if (isWindows && win32AppUserModelId) {
			invoke('set_app_user_model_id', { id: win32AppUserModelId }).catch(() => {});
		}

		// macOS native tabs fix
		try {
			if (isMacintosh && this.configurationService.getValue('window.nativeTabs') === true) {
				invoke('set_user_default', { key: 'NSUseImprovedLayoutPass', type: 'boolean', value: true }).catch(() => {});
			}
		} catch (error) {
			this.logService.error(error);
		}

		// Main process server (electron IPC based)
		const mainProcessElectronServer = new ElectronIPCServer();
		Event.once(this.lifecycleMainService.onWillShutdown)(e => {
			if (e.reason === ShutdownReason.KILL) { mainProcessElectronServer.dispose(); }
		});

		const [machineId, sqmId, devDeviceId] = await Promise.all([
			resolveMachineId(this.stateService, this.logService),
			resolveSqmId(this.stateService, this.logService),
			resolveDevDeviceId(this.stateService, this.logService)
		]);

		const { sharedProcessReady, sharedProcessClient } = this.setupSharedProcess(machineId, sqmId, devDeviceId);
		const appInstantiationService = await this.initServices(machineId, sqmId, devDeviceId, sharedProcessReady);

		appInstantiationService.invokeFunction(accessor => this._register(new ErrorTelemetry(accessor.get(ILogService), accessor.get(ITelemetryService))));
		appInstantiationService.invokeFunction(accessor => {
			(accessor.get(IMeteredConnectionService) as MeteredConnectionMainService).setTelemetryService(accessor.get(ITelemetryService));
		});
		appInstantiationService.invokeFunction(accessor => accessor.get(IProxyAuthService));
		this._register(appInstantiationService.createInstance(UserDataProfilesHandler));
		appInstantiationService.invokeFunction(accessor => this.initChannels(accessor, mainProcessElectronServer, sharedProcessClient));

		const initialProtocolUrls = await appInstantiationService.invokeFunction(accessor => this.setupProtocolUrlHandlers(accessor, mainProcessElectronServer));
		this.setupManagedRemoteResourceUrlHandler(mainProcessElectronServer);

		this.lifecycleMainService.phase = LifecycleMainPhase.Ready;
		await appInstantiationService.invokeFunction(accessor => this.openFirstWindow(accessor, initialProtocolUrls));
		this.lifecycleMainService.phase = LifecycleMainPhase.AfterWindowOpen;
		this.afterWindowOpen(appInstantiationService);

		const eventuallyPhaseScheduler = this._register(new RunOnceScheduler(() => {
			this._register(runWhenGlobalIdle(() => {
				this.lifecycleMainService.phase = LifecycleMainPhase.Eventually;
				this.eventuallyAfterWindowOpen();
			}, 2500));
		}, 2500));
		eventuallyPhaseScheduler.schedule();
	}

	private async setupProtocolUrlHandlers(accessor: ServicesAccessor, mainProcessElectronServer: ElectronIPCServer): Promise<IInitialProtocolUrls | undefined> {
		const windowsMainService = this.windowsMainService = accessor.get(IWindowsMainService);
		const urlService = accessor.get(IURLService);
		const nativeHostMainService = this.nativeHostMainService = accessor.get(INativeHostMainService);
		const dialogMainService = accessor.get(IDialogMainService);

		const app = this;
		urlService.registerHandler({
			async handleURL(uri: URI, options?: IOpenURLOptions): Promise<boolean> {
				return app.handleProtocolUrl(windowsMainService, dialogMainService, urlService, uri, options);
			}
		});

		const activeWindowManager = this._register(new ActiveWindowManager({
			onDidOpenMainWindow: nativeHostMainService.onDidOpenMainWindow,
			onDidFocusMainWindow: nativeHostMainService.onDidFocusMainWindow,
			getActiveWindowId: () => nativeHostMainService.getActiveWindowId(-1)
		}));
		const activeWindowRouter = new StaticRouter(ctx => activeWindowManager.getActiveClientId().then(id => ctx === id));
		const urlHandlerRouter = new URLHandlerRouter(activeWindowRouter, this.logService);
		const urlHandlerChannel = mainProcessElectronServer.getChannel('urlHandler', urlHandlerRouter);
		urlService.registerHandler(new URLHandlerChannelClient(urlHandlerChannel));

		const initialProtocolUrls = await this.resolveInitialProtocolUrls(windowsMainService, dialogMainService);
		this._register(new ElectronURLListener(initialProtocolUrls?.urls, urlService, windowsMainService, this.environmentMainService, this.productService, this.logService));

		return initialProtocolUrls;
	}

	private setupManagedRemoteResourceUrlHandler(mainProcessElectronServer: ElectronIPCServer) {
		const remoteResourceChannel = new Lazy(() => mainProcessElectronServer.getChannel(
			NODE_REMOTE_RESOURCE_CHANNEL_NAME,
			new NodeRemoteResourceRouter(),
		));

		invoke('register_buffer_protocol', {
			scheme: Schemas.vscodeManagedRemoteResource,
			channelName: NODE_REMOTE_RESOURCE_CHANNEL_NAME
		}).catch(err => this.logService.error('Failed to register buffer protocol:', err));
	}

	private async resolveInitialProtocolUrls(windowsMainService: IWindowsMainService, dialogMainService: IDialogMainService): Promise<IInitialProtocolUrls | undefined> {
		const protocolUrlsFromCommandLine = this.environmentMainService.args['open-url'] ? this.environmentMainService.args._urls || [] : [];
		const protocolUrlsFromEvent = ((global as { getOpenUrls?: () => string[] }).getOpenUrls?.() || []);

		if (protocolUrlsFromCommandLine.length + protocolUrlsFromEvent.length === 0) { return undefined; }

		const protocolUrls = [...protocolUrlsFromCommandLine, ...protocolUrlsFromEvent].map(url => {
			try { return { uri: URI.parse(url), originalUrl: url }; }
			catch { return undefined; }
		});

		const openables: IWindowOpenable[] = [];
		const urls: IProtocolUrl[] = [];

		for (const protocolUrl of protocolUrls) {
			if (!protocolUrl) { continue; }
			const windowOpenable = this.getWindowOpenableFromProtocolUrl(protocolUrl.uri);
			if (windowOpenable) {
				if ((process as INodeProcess).isEmbeddedApp) { continue; }
				if (await this.shouldBlockOpenable(windowOpenable, windowsMainService, dialogMainService)) { continue; }
				openables.push(windowOpenable);
			} else {
				urls.push(protocolUrl);
			}
		}
		return { urls, openables };
	}

	private async shouldBlockOpenable(openable: IWindowOpenable, windowsMainService: IWindowsMainService, dialogMainService: IDialogMainService): Promise<boolean> {
		let openableUri: URI;
		let message: string;
		if (isWorkspaceToOpen(openable)) {
			openableUri = openable.workspaceUri;
			message = localize('confirmOpenMessageWorkspace', "An external application wants to open '{0}' in {1}. Do you want to open this workspace file?", openableUri.scheme === Schemas.file ? getPathLabel(openableUri, { os: OS, tildify: this.environmentMainService }) : openableUri.toString(true), this.productService.nameShort);
		} else if (isFolderToOpen(openable)) {
			openableUri = openable.folderUri;
			message = localize('confirmOpenMessageFolder', "An external application wants to open '{0}' in {1}. Do you want to open this folder?", openableUri.scheme === Schemas.file ? getPathLabel(openableUri, { os: OS, tildify: this.environmentMainService }) : openableUri.toString(true), this.productService.nameShort);
		} else {
			openableUri = openable.fileUri;
			message = localize('confirmOpenMessageFileOrFolder', "An external application wants to open '{0}' in {1}. Do you want to open this file or folder?", openableUri.scheme === Schemas.file ? getPathLabel(openableUri, { os: OS, tildify: this.environmentMainService }) : openableUri.toString(true), this.productService.nameShort);
		}

		if (openableUri.scheme !== Schemas.file && openableUri.scheme !== Schemas.vscodeRemote) { return false; }

		const askForConfirmation = this.configurationService.getValue<unknown>(CodeApplication.SECURITY_PROTOCOL_HANDLING_CONFIRMATION_SETTING_KEY[openableUri.scheme]);
		if (askForConfirmation === false) { return false; }

		const { response, checkboxChecked } = await dialogMainService.showMessageBox({
			type: 'warning',
			buttons: [
				localize({ key: 'open', comment: ['&& denotes a mnemonic'] }, "&&Yes"),
				localize({ key: 'cancel', comment: ['&& denotes a mnemonic'] }, "&&No")
			],
			message,
			detail: localize('confirmOpenDetail', "If you did not initiate this request, it may represent an attempted attack on your system. Unless you took an explicit action to initiate this request, you should press 'No'"),
			checkboxLabel: openableUri.scheme === Schemas.file ? localize('doNotAskAgainLocal', "Allow opening local paths without asking") : localize('doNotAskAgainRemote', "Allow opening remote paths without asking"),
			cancelId: 1
		});

		if (response !== 0) { return true; }
		if (checkboxChecked) {
			const request = { channel: 'vscode:disablePromptForProtocolHandling', args: openableUri.scheme === Schemas.file ? 'local' : 'remote' };
			windowsMainService.sendToFocused(request.channel, request.args);
			windowsMainService.sendToOpeningWindow(request.channel, request.args);
		}
		return false;
	}

	private getWindowOpenableFromProtocolUrl(uri: URI): IWindowOpenable | undefined {
		if (!uri.path) { return undefined; }
		if (uri.authority === Schemas.file) {
			const fileUri = URI.file(uri.fsPath);
			if (hasWorkspaceFileExtension(fileUri)) { return { workspaceUri: fileUri }; }
			return { fileUri };
		} else if (uri.authority === Schemas.vscodeRemote) {
			const secondSlash = uri.path.indexOf(posix.sep, 1);
			let authority: string;
			let path: string;
			if (secondSlash !== -1) { authority = uri.path.substring(1, secondSlash); path = uri.path.substring(secondSlash); }
			else { authority = uri.path.substring(1); path = '/'; }
			let query = uri.query;
			const params = new URLSearchParams(uri.query);
			if (params.get('windowId') === '_blank') { params.delete('windowId'); query = params.toString(); }
			const remoteUri = URI.from({ scheme: Schemas.vscodeRemote, authority, path, query, fragment: uri.fragment });
			if (hasWorkspaceFileExtension(path)) { return { workspaceUri: remoteUri }; }
			if (/:[\d]+$/.test(path)) { return { fileUri: remoteUri }; }
			return { folderUri: remoteUri };
		}
		return undefined;
	}

	private async handleProtocolUrl(windowsMainService: IWindowsMainService, dialogMainService: IDialogMainService, urlService: IURLService, uri: URI, options?: IOpenURLOptions): Promise<boolean> {
		this.logService.trace('app#handleProtocolUrl():', uri.toString(true), options);

		if ((process as INodeProcess).isEmbeddedApp) {
			const windowOpenable = this.getWindowOpenableFromProtocolUrl(uri);
			if (windowOpenable) { return true; }
			const windows = await windowsMainService.openAgentsWindow({ context: OpenContext.LINK, contextWindowId: undefined });
			const window = windows.at(0);
			window?.focus();
			await window?.ready();
			return false;
		}

		if (uri.scheme === this.productService.urlProtocol && uri.path === 'workspace') {
			uri = uri.with({ authority: Schemas.file, path: URI.parse(uri.query).path, query: '' });
		}

		let shouldOpenInNewWindow = false;
		const params = new URLSearchParams(uri.query);
		if (params.get('windowId') === '_blank') {
			params.delete('windowId');
			uri = uri.with({ query: params.toString() });
			shouldOpenInNewWindow = true;
		} else if (isMacintosh && windowsMainService.getWindowCount() === 0) {
			shouldOpenInNewWindow = true;
		}

		const continueOn = params.get('continueOn');
		if (continueOn !== null) {
			params.delete('continueOn');
			uri = uri.with({ query: params.toString() });
			this.environmentMainService.continueOn = continueOn ?? undefined;
		}

		const session = params.get('session');
		if (session !== null) { params.delete('session'); uri = uri.with({ query: params.toString() }); }

		const windowOpenableFromProtocolUrl = this.getWindowOpenableFromProtocolUrl(uri);
		if (windowOpenableFromProtocolUrl) {
			if (await this.shouldBlockOpenable(windowOpenableFromProtocolUrl, windowsMainService, dialogMainService)) { return true; }
			const window = (await windowsMainService.open({
				context: OpenContext.LINK, cli: { ...this.environmentMainService.args },
				urisToOpen: [windowOpenableFromProtocolUrl], forceNewWindow: shouldOpenInNewWindow, gotoLineMode: true
			})).at(0);
			window?.focus();
			if (window && session) { window.sendWhenReady('vscode:openChatSession', CancellationToken.None, session); }
			return true;
		}

		if (shouldOpenInNewWindow) {
			const window = (await windowsMainService.open({
				context: OpenContext.LINK, cli: { ...this.environmentMainService.args },
				forceNewWindow: true, forceEmpty: true, gotoLineMode: true, remoteAuthority: getRemoteAuthority(uri)
			})).at(0);
			await window?.ready();
			return urlService.open(uri, options);
		}

		return false;
	}

	private setupSharedProcess(machineId: string, sqmId: string, devDeviceId: string): { sharedProcessReady: Promise<MessagePortClient>; sharedProcessClient: Promise<MessagePortClient> } {
		const sharedProcess = this._register(this.mainInstantiationService.createInstance(SharedProcess, machineId, sqmId, devDeviceId));
		this._register(sharedProcess.onDidCrash(() => this.windowsMainService?.sendToFocused('vscode:reportSharedProcessCrash')));
		const sharedProcessClient = (async () => {
			this.logService.trace('Main->SharedProcess#connect');
			const port = await sharedProcess.connect();
			this.logService.trace('Main->SharedProcess#connect: connection established');
			return new MessagePortClient(port, 'main');
		})();
		const sharedProcessReady = (async () => { await sharedProcess.whenReady(); return sharedProcessClient; })();
		return { sharedProcessReady, sharedProcessClient };
	}

	private async initServices(machineId: string, sqmId: string, devDeviceId: string, sharedProcessReady: Promise<MessagePortClient>): Promise<IInstantiationService> {
		const services = new ServiceCollection();

		switch (process.platform) {
			case 'win32': services.set(IUpdateService, new SyncDescriptor(Win32UpdateService)); break;
			case 'linux':
				if (isLinuxSnap) { services.set(IUpdateService, new SyncDescriptor(SnapUpdateService, [process.env['SNAP'], process.env['SNAP_REVISION']])); }
				else { services.set(IUpdateService, new SyncDescriptor(LinuxUpdateService)); }
				break;
			case 'darwin': services.set(IUpdateService, new SyncDescriptor(DarwinUpdateService)); break;
		}

		services.set(IWindowsMainService, new SyncDescriptor(WindowsMainService, [machineId, sqmId, devDeviceId, this.userEnv], false));
		services.set(IAuxiliaryWindowsMainService, new SyncDescriptor(AuxiliaryWindowsMainService, undefined, false));

		const dialogMainService = new DialogMainService(this.logService, this.productService);
		services.set(IDialogMainService, dialogMainService);
		services.set(ILaunchMainService, new SyncDescriptor(LaunchMainService, undefined, false));
		services.set(IDiagnosticsMainService, new SyncDescriptor(DiagnosticsMainService, undefined, false));
		services.set(IDiagnosticsService, ProxyChannel.toService(getDelayedChannel(sharedProcessReady.then(client => client.getChannel('diagnostics')))));
		services.set(IEncryptionMainService, new SyncDescriptor(EncryptionMainService));
		services.set(INativeBrowserElementsMainService, new SyncDescriptor(NativeBrowserElementsMainService, undefined, false));
		services.set(IBrowserViewMainService, new SyncDescriptor(BrowserViewMainService, undefined, false));
		services.set(IBrowserViewGroupMainService, new SyncDescriptor(BrowserViewGroupMainService, undefined, false));
		services.set(IKeyboardLayoutMainService, new SyncDescriptor(KeyboardLayoutMainService));
		services.set(INativeHostMainService, new SyncDescriptor(NativeHostMainService, undefined, false));

		const meteredConnectionService = new MeteredConnectionMainService(this.configurationService);
		services.set(IMeteredConnectionService, meteredConnectionService);
		services.set(IWebContentExtractorService, new SyncDescriptor(NativeWebContentExtractorService, undefined, false));
		services.set(IWebviewManagerService, new SyncDescriptor(WebviewMainService));
		services.set(IMenubarMainService, new SyncDescriptor(MenubarMainService));
		services.set(IExtensionHostStarter, new SyncDescriptor(ExtensionHostStarter));
		services.set(IStorageMainService, new SyncDescriptor(StorageMainService));
		services.set(IApplicationStorageMainService, new SyncDescriptor(ApplicationStorageMainService));

		const ptyHostStarter = new ElectronPtyHostStarter({
			graceTime: LocalReconnectConstants.GraceTime,
			shortGraceTime: LocalReconnectConstants.ShortGraceTime,
			scrollback: this.configurationService.getValue<number>(TerminalSettingId.PersistentSessionScrollback) ?? 100
		}, this.configurationService, this.environmentMainService, this.lifecycleMainService, this.logService);
		services.set(ILocalPtyService, new PtyHostService(ptyHostStarter, this.configurationService, this.logService, this.loggerService));

		if (this.configurationService.getValue(AgentHostEnabledSettingId)) {
			const agentHostStarter = new ElectronAgentHostStarter(this.environmentMainService, this.lifecycleMainService, this.logService);
			this._register(new AgentHostProcessManager(agentHostStarter, this.logService, this.loggerService));
		}

		if (isWindows) { services.set(IExternalTerminalMainService, new SyncDescriptor(WindowsExternalTerminalService)); }
		else if (isMacintosh) { services.set(IExternalTerminalMainService, new SyncDescriptor(MacExternalTerminalService)); }
		else if (isLinux) { services.set(IExternalTerminalMainService, new SyncDescriptor(LinuxExternalTerminalService)); }
		services.set(ISandboxHelperMainService, new SyncDescriptor(SandboxHelperService));

		const backupMainService = new BackupMainService(this.environmentMainService, this.configurationService, this.logService, this.stateService);
		services.set(IBackupMainService, backupMainService);

		const workspacesManagementMainService = new WorkspacesManagementMainService(this.environmentMainService, this.logService, this.userDataProfilesMainService, backupMainService, dialogMainService);
		services.set(IWorkspacesManagementMainService, workspacesManagementMainService);
		services.set(IWorkspacesService, new SyncDescriptor(WorkspacesMainService, undefined, false));
		services.set(IWorkspacesHistoryMainService, new SyncDescriptor(WorkspacesHistoryMainService, undefined, false));
		services.set(IURLService, new SyncDescriptor(NativeURLService, undefined, false));

		if (supportsTelemetry(this.productService, this.environmentMainService)) {
			const isInternal = isInternalTelemetry(this.productService, this.configurationService);
			const channel = getDelayedChannel(sharedProcessReady.then(client => client.getChannel('telemetryAppender')));
			const appender = new TelemetryAppenderClient(channel);
			const commonProperties = resolveCommonProperties(release(), hostname(), process.arch, this.productService.commit, this.productService.version, machineId, sqmId, devDeviceId, isInternal, this.productService.date, this.productService.telemetryAppName);
			const piiPaths = getPiiPathsFromEnvironment(this.environmentMainService);
			services.set(ITelemetryService, new SyncDescriptor(TelemetryService, [{ appenders: [appender], commonProperties, piiPaths, sendErrorTelemetry: true }], false));
		} else {
			services.set(ITelemetryService, NullTelemetryService);
		}

		services.set(IExtensionsProfileScannerService, new SyncDescriptor(ExtensionsProfileScannerService, undefined, true));
		services.set(IExtensionsScannerService, new SyncDescriptor(ExtensionsScannerService, undefined, true));
		services.set(IUtilityProcessWorkerMainService, new SyncDescriptor(UtilityProcessWorkerMainService, undefined, true));
		services.set(IProxyAuthService, new SyncDescriptor(ProxyAuthService));
		services.set(INativeMcpDiscoveryHelperService, new SyncDescriptor(NativeMcpDiscoveryHelperService));
		services.set(IMcpGatewayService, new SyncDescriptor(McpGatewayService));
		services.set(ICSSDevelopmentService, new SyncDescriptor(CSSDevelopmentService, undefined, true));

		await Promises.settled([backupMainService.initialize(), workspacesManagementMainService.initialize()]);
		return this.mainInstantiationService.createChild(services);
	}

	private initChannels(accessor: ServicesAccessor, mainProcessElectronServer: ElectronIPCServer, sharedProcessClient: Promise<MessagePortClient>): void {
		const disposables = this._register(new DisposableStore());

		const launchChannel = ProxyChannel.fromService(accessor.get(ILaunchMainService), disposables, { disableMarshalling: true });
		this.mainProcessNodeIpcServer.registerChannel('launch', launchChannel);
		const diagnosticsChannel = ProxyChannel.fromService(accessor.get(IDiagnosticsMainService), disposables, { disableMarshalling: true });
		this.mainProcessNodeIpcServer.registerChannel('diagnostics', diagnosticsChannel);

		const policyChannel = disposables.add(new PolicyChannel(accessor.get(IPolicyService)));
		mainProcessElectronServer.registerChannel('policy', policyChannel);
		sharedProcessClient.then(client => client.registerChannel('policy', policyChannel));

		const diskFileSystemProvider = this.fileService.getProvider(Schemas.file);
		assertType(diskFileSystemProvider instanceof DiskFileSystemProvider);
		const fileSystemProviderChannel = disposables.add(new DiskFileSystemProviderChannel(diskFileSystemProvider, this.logService, this.environmentMainService));
		mainProcessElectronServer.registerChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME, fileSystemProviderChannel);
		sharedProcessClient.then(client => client.registerChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME, fileSystemProviderChannel));

		const userDataProfilesService = ProxyChannel.fromService(accessor.get(IUserDataProfilesMainService), disposables);
		mainProcessElectronServer.registerChannel('userDataProfiles', userDataProfilesService);
		sharedProcessClient.then(client => client.registerChannel('userDataProfiles', userDataProfilesService));

		mainProcessElectronServer.registerChannel('update', new UpdateChannel(accessor.get(IUpdateService)));

		const meteredConnectionChannel = new MeteredConnectionChannel(accessor.get(IMeteredConnectionService) as MeteredConnectionMainService);
		mainProcessElectronServer.registerChannel(METERED_CONNECTION_CHANNEL, meteredConnectionChannel);
		sharedProcessClient.then(client => client.registerChannel(METERED_CONNECTION_CHANNEL, meteredConnectionChannel));

		mainProcessElectronServer.registerChannel('process', ProxyChannel.fromService(new ProcessMainService(this.logService, accessor.get(IDiagnosticsService), accessor.get(IDiagnosticsMainService)), disposables));
		mainProcessElectronServer.registerChannel('encryption', ProxyChannel.fromService(accessor.get(IEncryptionMainService), disposables));

		const browserElementsChannel = ProxyChannel.fromService(accessor.get(INativeBrowserElementsMainService), disposables);
		mainProcessElectronServer.registerChannel('browserElements', browserElementsChannel);
		sharedProcessClient.then(client => client.registerChannel('browserElements', browserElementsChannel));

		mainProcessElectronServer.registerChannel(ipcBrowserViewChannelName, ProxyChannel.fromService(accessor.get(IBrowserViewMainService), disposables));
		mainProcessElectronServer.registerChannel(ipcBrowserViewGroupChannelName, ProxyChannel.fromService(accessor.get(IBrowserViewGroupMainService), disposables));
		mainProcessElectronServer.registerChannel('sign', ProxyChannel.fromService(accessor.get(ISignService), disposables));
		mainProcessElectronServer.registerChannel('keyboardLayout', ProxyChannel.fromService(accessor.get(IKeyboardLayoutMainService), disposables));

		this.nativeHostMainService = accessor.get(INativeHostMainService);
		const nativeHostChannel = ProxyChannel.fromService(this.nativeHostMainService, disposables);
		mainProcessElectronServer.registerChannel('nativeHost', nativeHostChannel);
		sharedProcessClient.then(client => client.registerChannel('nativeHost', nativeHostChannel));

		mainProcessElectronServer.registerChannel('webContentExtractor', ProxyChannel.fromService(accessor.get(IWebContentExtractorService), disposables));
		mainProcessElectronServer.registerChannel('workspaces', ProxyChannel.fromService(accessor.get(IWorkspacesService), disposables));
		mainProcessElectronServer.registerChannel('menubar', ProxyChannel.fromService(accessor.get(IMenubarMainService), disposables));
		mainProcessElectronServer.registerChannel('url', ProxyChannel.fromService(accessor.get(IURLService), disposables));
		mainProcessElectronServer.registerChannel('webview', ProxyChannel.fromService(accessor.get(IWebviewManagerService), disposables));

		const storageChannel = disposables.add(new StorageDatabaseChannel(this.logService, accessor.get(IStorageMainService)));
		mainProcessElectronServer.registerChannel('storage', storageChannel);
		sharedProcessClient.then(client => client.registerChannel('storage', storageChannel));

		const profileStorageListener = disposables.add(new ProfileStorageChangesListenerChannel(accessor.get(IStorageMainService), accessor.get(IUserDataProfilesMainService), this.logService));
		sharedProcessClient.then(client => client.registerChannel('profileStorageListener', profileStorageListener));

		mainProcessElectronServer.registerChannel(TerminalIpcChannels.LocalPty, ProxyChannel.fromService(accessor.get(ILocalPtyService), disposables));
		mainProcessElectronServer.registerChannel('externalTerminal', ProxyChannel.fromService(accessor.get(IExternalTerminalMainService), disposables));
		mainProcessElectronServer.registerChannel('sandboxHelper', ProxyChannel.fromService(accessor.get(ISandboxHelperMainService), disposables));

		mainProcessElectronServer.registerChannel(NativeMcpDiscoveryHelperChannelName, ProxyChannel.fromService(accessor.get(INativeMcpDiscoveryHelperService), disposables));
		const mcpGatewayChannel = this._register(new McpGatewayChannel(mainProcessElectronServer, accessor.get(IMcpGatewayService), accessor.get(ILoggerMainService)));
		mainProcessElectronServer.registerChannel(McpGatewayChannelName, mcpGatewayChannel);

		const loggerChannel = new LoggerChannel(accessor.get(ILoggerMainService));
		mainProcessElectronServer.registerChannel('logger', loggerChannel);
		sharedProcessClient.then(client => client.registerChannel('logger', loggerChannel));

		mainProcessElectronServer.registerChannel('extensionhostdebugservice', new ElectronExtensionHostDebugBroadcastChannel(accessor.get(IWindowsMainService)));
		mainProcessElectronServer.registerChannel(ipcExtensionHostStarterChannelName, ProxyChannel.fromService(accessor.get(IExtensionHostStarter), disposables));
		mainProcessElectronServer.registerChannel(ipcUtilityProcessWorkerChannelName, ProxyChannel.fromService(accessor.get(IUtilityProcessWorkerMainService), disposables));
	}

	private async openFirstWindow(accessor: ServicesAccessor, initialProtocolUrls: IInitialProtocolUrls | undefined): Promise<ICodeWindow[]> {
		const windowsMainService = this.windowsMainService = accessor.get(IWindowsMainService);
		this.auxiliaryWindowsMainService = accessor.get(IAuxiliaryWindowsMainService);

		const context = isLaunchedFromCli(process.env) ? OpenContext.CLI : OpenContext.DESKTOP;
		const args = this.environmentMainService.args;

		if ((process as INodeProcess).isEmbeddedApp || (args['agents'] && this.productService.quality !== 'stable')) {
			return windowsMainService.openAgentsWindow({ context, contextWindowId: undefined });
		}

		if (initialProtocolUrls) {
			if (initialProtocolUrls.openables.length > 0) {
				return windowsMainService.open({ context, cli: args, urisToOpen: initialProtocolUrls.openables, gotoLineMode: true, initialStartup: true });
			}
			if (initialProtocolUrls.urls.length > 0) {
				for (const protocolUrl of initialProtocolUrls.urls) {
					const params = new URLSearchParams(protocolUrl.uri.query);
					if (params.get('windowId') === '_blank') {
						params.delete('windowId');
						protocolUrl.originalUrl = protocolUrl.uri.toString(true);
						protocolUrl.uri = protocolUrl.uri.with({ query: params.toString() });
						return windowsMainService.open({ context, cli: args, forceNewWindow: true, forceEmpty: true, gotoLineMode: true, initialStartup: true });
					}
				}
			}
		}

		const macOpenFiles: string[] = (global as { macOpenFiles?: string[] }).macOpenFiles ?? [];
		const hasCliArgs = args._.length;
		const hasFolderURIs = !!args['folder-uri'];
		const hasFileURIs = !!args['file-uri'];
		const noRecentEntry = args['skip-add-to-recently-opened'] === true;
		const waitMarkerFileURI = args.wait && args.waitMarkerFilePath ? URI.file(args.waitMarkerFilePath) : undefined;
		const remoteAuthority = args.remote || undefined;
		const forceProfile = args.profile;
		const forceTempProfile = args['profile-temp'];

		if (!hasCliArgs && !hasFolderURIs && !hasFileURIs) {
			if (args['new-window'] || forceProfile || forceTempProfile) {
				return windowsMainService.open({ context, cli: args, forceNewWindow: true, forceEmpty: true, noRecentEntry, waitMarkerFileURI, initialStartup: true, remoteAuthority, forceProfile, forceTempProfile });
			}
			if (macOpenFiles.length) {
				return windowsMainService.open({
					context: OpenContext.DOCK, cli: args,
					urisToOpen: macOpenFiles.map(path => { path = normalizeNFC(path); return hasWorkspaceFileExtension(path) ? { workspaceUri: URI.file(path) } : { fileUri: URI.file(path) }; }),
					noRecentEntry, waitMarkerFileURI, initialStartup: true,
				});
			}
		}

		return windowsMainService.open({ context, cli: args, forceNewWindow: args['new-window'], diffMode: args.diff, mergeMode: args.merge, noRecentEntry, waitMarkerFileURI, gotoLineMode: args.goto, initialStartup: true, remoteAuthority, forceProfile, forceTempProfile });
	}

	private afterWindowOpen(instantiationService: IInstantiationService): void {
		if (isWindows) { initWindowsVersionInfo(); }
		this.installMutex();

		// Register remote resource protocol via Rust backend
		invoke('register_http_protocol', { scheme: Schemas.vscodeRemoteResource }).catch(() => {});

		this.resolveShellEnvironment(this.environmentMainService.args, process.env, true);
		this.updateCrashReporterEnablement();

		if (isMacintosh) {
			invoke<boolean>('is_running_under_arm64_translation').then(isTranslated => {
				if (isTranslated) { this.windowsMainService?.sendToFocused('vscode:showTranslatedBuildWarning'); }
			}).catch(() => {});
		}

		// Power telemetry via invoke
		instantiationService.invokeFunction(accessor => {
			const telemetryService = accessor.get(ITelemetryService);

			tauriListen('power://suspend', async () => {
				const data = await this.getPowerEventData();
				telemetryService.publicLog2('power.suspend', data);
			}).catch(() => {});

			tauriListen('power://resume', async () => {
				const data = await this.getPowerEventData();
				telemetryService.publicLog2('power.resume', data);
			}).catch(() => {});
		});
	}

	private async getPowerEventData(): Promise<{ idleState: string; idleTime: number; thermalState: string; onBattery: boolean }> {
		const [idleState, idleTime, thermalState, onBattery] = await Promise.all([
			invoke<string>('get_system_idle_state', { idleThreshold: 60 }).catch(() => 'unknown'),
			invoke<number>('get_system_idle_time').catch(() => 0),
			invoke<string>('get_current_thermal_state').catch(() => 'unknown'),
			invoke<boolean>('is_on_battery_power').catch(() => false),
		]);
		return { idleState, idleTime, thermalState, onBattery };
	}

	private async installMutex(): Promise<void> {
		const win32MutexName = this.productService.win32MutexName;
		if (isWindows && win32MutexName) {
			try {
				const WindowsMutex = await import('@vscode/windows-mutex');
				const mutex = new WindowsMutex.Mutex(win32MutexName);
				Event.once(this.lifecycleMainService.onWillShutdown)(() => mutex.release());
			} catch (error) {
				this.logService.error(error);
			}
		}
	}

	private async resolveShellEnvironment(args: NativeParsedArgs, env: IProcessEnvironment, notifyOnError: boolean): Promise<typeof process.env> {
		try {
			return await getResolvedShellEnv(this.configurationService, this.logService, args, env);
		} catch (error) {
			const errorMessage = toErrorMessage(error);
			if (notifyOnError) { this.windowsMainService?.sendToFocused('vscode:showResolveShellEnvError', errorMessage); }
			else { this.logService.error(errorMessage); }
		}
		return {};
	}

	private async updateCrashReporterEnablement(): Promise<void> {
		try {
			const argvContent = await this.fileService.readFile(this.environmentMainService.argvResource);
			const argvString = argvContent.value.toString();
			const argvJSON = parse<{ 'enable-crash-reporter'?: boolean }>(argvString);
			const telemetryLevel = getTelemetryLevel(this.configurationService);
			const enableCrashReporter = telemetryLevel >= TelemetryLevel.CRASH;

			if (argvJSON['enable-crash-reporter'] === undefined) {
				const additionalArgvContent = ['', '	// Allows to disable crash reporting.', '	// Should restart the app if the value is changed.', `	"enable-crash-reporter": ${enableCrashReporter},`, '', '	// Unique id used for correlating crash reports sent from this instance.', '	// Do not edit this value.', `	"crash-reporter-id": "${generateUuid()}"`, '}'];
				const newArgvString = argvString.substring(0, argvString.length - 2).concat(',\n', additionalArgvContent.join('\n'));
				await this.fileService.writeFile(this.environmentMainService.argvResource, VSBuffer.fromString(newArgvString));
			} else {
				const newArgvString = argvString.replace(/"enable-crash-reporter": .*,/, `"enable-crash-reporter": ${enableCrashReporter},`);
				if (newArgvString !== argvString) { await this.fileService.writeFile(this.environmentMainService.argvResource, VSBuffer.fromString(newArgvString)); }
			}
		} catch (error) {
			this.logService.error(error);
			this.windowsMainService?.sendToFocused('vscode:showArgvParseWarning');
		}
	}

	private eventuallyAfterWindowOpen(): void {
		validateDevDeviceId(this.stateService, this.logService);
	}
}
