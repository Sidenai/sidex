/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { env } from '../../../base/common/process.js';
import { IProductConfiguration } from '../../../base/common/product.js';
import { ISandboxConfiguration } from '../../../base/parts/sandbox/common/sandboxTypes.js';

/**
 * @deprecated It is preferred that you use `IProductService` if you can. This
 * allows web embedders to override our defaults. But for things like `product.quality`,
 * the use is fine because that property is not overridable.
 */
let product: IProductConfiguration;

// Native sandbox environment
const vscodeGlobal = (globalThis as { vscode?: { context?: { configuration(): ISandboxConfiguration | undefined } } })
	.vscode;
if (typeof vscodeGlobal !== 'undefined' && typeof vscodeGlobal.context !== 'undefined') {
	const configuration: ISandboxConfiguration | undefined = vscodeGlobal.context.configuration();
	if (configuration) {
		product = configuration.product;
	} else {
		throw new Error('Sandbox: unable to resolve product configuration from preload script.');
	}
}
// _VSCODE environment
else if (globalThis._VSCODE_PRODUCT_JSON && globalThis._VSCODE_PACKAGE_JSON) {
	// Obtain values from product.json and package.json-data
	product = globalThis._VSCODE_PRODUCT_JSON as unknown as IProductConfiguration;

	// Running out of sources
	if (env['VSCODE_DEV']) {
		Object.assign(product, {
			nameShort: `${product.nameShort} Dev`,
			nameLong: `${product.nameLong} Dev`,
			dataFolderName: `${product.dataFolderName}-dev`,
			serverDataFolderName: product.serverDataFolderName ? `${product.serverDataFolderName}-dev` : undefined
		});
	}

	// Version is added during built time, but we still
	// want to have it running out of sources so we
	// read it from package.json only when we need it.
	if (!product.version) {
		const pkg = globalThis._VSCODE_PACKAGE_JSON as { version: string };

		Object.assign(product, {
			version: pkg.version
		});
	}
}

// Web environment or unknown
else {
	// Built time configuration (do NOT modify)
	product = {
		/*BUILD->INSERT_PRODUCT_CONFIGURATION*/
	} as unknown as IProductConfiguration;

	// Running out of sources
	if (Object.keys(product).length === 0) {
		Object.assign(product, {
			version: '1.110.0',
			nameShort: 'SideX',
			nameLong: 'SideX',
			applicationName: 'sidex',
			dataFolderName: '.sidex',
			urlProtocol: 'sidex',
			reportIssueUrl: 'https://github.com/Razshy/sidexvs/issues/new',
			licenseName: 'MIT',
			licenseUrl: 'https://github.com/Razshy/sidexvs/blob/main/LICENSE',
			serverLicenseUrl: 'https://github.com/Razshy/sidexvs/blob/main/LICENSE',
			extensionsGallery: {
				serviceUrl: 'https://marketplace.siden.ai/api/gallery',
				controlUrl: 'https://az764295.vo.msecnd.net/extensions/marketplace.json',
				extensionUrlTemplate:
					'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/{publisher}/vsextensions/{name}/{version}/vspackage',
				resourceUrlTemplate: 'https://{publisher}.vscode-unpkg.net/{publisher}/{name}/{version}/{path}',
				nlsBaseUrl: 'https://az764295.vo.msecnd.net/extensions/{publisher}/{name}/{version}/{lang}.json'
			}
		});
	}
}

export default product;
