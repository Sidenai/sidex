/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IBuiltinExtensionsScannerService,
	ExtensionType,
	IExtensionManifest,
	TargetPlatform,
	IExtension
} from '../../../../platform/extensions/common/extensions.js';
import { isWeb, Language } from '../../../../base/common/platform.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { getGalleryExtensionId } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { builtinExtensionsPath, FileAccess } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ITranslations, localizeManifest } from '../../../../platform/extensionManagement/common/extensionNls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { mainWindow } from '../../../../base/browser/window.js';

interface IBundledExtension {
	extensionPath: string;
	packageJSON: IExtensionManifest;
	packageNLS?: ITranslations;
	readmePath?: string;
	changelogPath?: string;
}

export class BuiltinExtensionsScannerService implements IBuiltinExtensionsScannerService {
	declare readonly _serviceBrand: undefined;

	private readonly builtinExtensionsPromises: Promise<IExtension>[] = [];

	private nlsUrl: URI | undefined;

	constructor(
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IExtensionResourceLoaderService private readonly extensionResourceLoaderService: IExtensionResourceLoaderService,
		@IProductService productService: IProductService,
		@ILogService private readonly logService: ILogService
	) {
		if (isWeb) {
			const nlsBaseUrl = productService.extensionsGallery?.nlsBaseUrl;
			// Only use the nlsBaseUrl if we are using a language other than the default, English.
			if (nlsBaseUrl && productService.commit && !Language.isDefaultVariant()) {
				this.nlsUrl = URI.joinPath(
					URI.parse(nlsBaseUrl),
					productService.commit,
					productService.version,
					Language.value()
				);
			}

			const builtinExtensionsServiceUrl = FileAccess.asBrowserUri(builtinExtensionsPath);
			this.logService.info(
				`[SideX-Builtin] builtinExtensionsServiceUrl = ${builtinExtensionsServiceUrl?.toString?.()}`
			);
			if (builtinExtensionsServiceUrl) {
				let bundledExtensions: IBundledExtension[] = [];

				// Prefer globalThis (set by builtin-extensions.js without DOM overhead)
				if ((globalThis as any)._VSCODE_BUILTIN_EXTENSIONS) {
					bundledExtensions = (globalThis as any)._VSCODE_BUILTIN_EXTENSIONS;
					delete (globalThis as any)._VSCODE_BUILTIN_EXTENSIONS;
					this.logService.info(
						`[SideX-Builtin] loaded ${bundledExtensions.length} extensions from _VSCODE_BUILTIN_EXTENSIONS`
					);
				} else {
					// Fallback: check for DOM meta element

					const builtinExtensionsElement = mainWindow.document.getElementById('vscode-workbench-builtin-extensions');
					const builtinExtensionsElementAttribute = builtinExtensionsElement
						? builtinExtensionsElement.getAttribute('data-settings')
						: undefined;
					this.logService.info(
						`[SideX-Builtin] DOM meta element present? ${!!builtinExtensionsElement} data-settings length? ${builtinExtensionsElementAttribute?.length ?? 0}`
					);
					if (builtinExtensionsElementAttribute) {
						try {
							bundledExtensions = JSON.parse(builtinExtensionsElementAttribute);
							this.logService.info(`[SideX-Builtin] parsed ${bundledExtensions.length} extensions from DOM`);
						} catch (_error) {
							/* ignore error*/
						}
					}
				}

				this.builtinExtensionsPromises = bundledExtensions.map(async e => {
					const id = getGalleryExtensionId(e.packageJSON.publisher, e.packageJSON.name);
					return {
						identifier: { id },
						location: uriIdentityService.extUri.joinPath(builtinExtensionsServiceUrl, e.extensionPath),
						type: ExtensionType.System,
						isBuiltin: true,
						manifest: e.packageNLS ? await this.localizeManifest(id, e.packageJSON, e.packageNLS) : e.packageJSON,
						readmeUrl: e.readmePath
							? uriIdentityService.extUri.joinPath(builtinExtensionsServiceUrl, e.readmePath)
							: undefined,
						changelogUrl: e.changelogPath
							? uriIdentityService.extUri.joinPath(builtinExtensionsServiceUrl, e.changelogPath)
							: undefined,
						targetPlatform: TargetPlatform.WEB,
						validations: [],
						isValid: true,
						preRelease: false
					};
				});
			}
		}
	}

	async scanBuiltinExtensions(): Promise<IExtension[]> {
		return [...(await Promise.all(this.builtinExtensionsPromises))];
	}

	private async localizeManifest(
		extensionId: string,
		manifest: IExtensionManifest,
		fallbackTranslations: ITranslations
	): Promise<IExtensionManifest> {
		if (!this.nlsUrl) {
			return localizeManifest(this.logService, manifest, fallbackTranslations);
		}
		// the `package` endpoint returns the translations in a key-value format similar to the package.nls.json file.
		const uri = URI.joinPath(this.nlsUrl, extensionId, 'package');
		try {
			const res = await this.extensionResourceLoaderService.readExtensionResource(uri);
			const json = JSON.parse(res.toString());
			return localizeManifest(this.logService, manifest, json, fallbackTranslations);
		} catch (e) {
			this.logService.error(e);
			return localizeManifest(this.logService, manifest, fallbackTranslations);
		}
	}
}

registerSingleton(IBuiltinExtensionsScannerService, BuiltinExtensionsScannerService, InstantiationType.Delayed);
