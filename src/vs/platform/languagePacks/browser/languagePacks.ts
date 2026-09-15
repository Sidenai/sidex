/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { ILanguagePackItem, ILanguagePackService } from '../common/languagePacks.js';
import { IExtensionGalleryService } from '../../extensionManagement/common/extensionManagement.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';

export class WebLanguagePacksService implements ILanguagePackService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IExtensionGalleryService private readonly galleryService: IExtensionGalleryService,
		@IExtensionService private readonly extensionService: IExtensionService
	) {}

	async getBuiltInExtensionTranslationsUri(_id: string, _language: string): Promise<URI | undefined> {
		return undefined;
	}

	async getAvailableLanguages(): Promise<ILanguagePackItem[]> {
		if (!this.galleryService.isEnabled()) {
			return [];
		}
		try {
			const result = await this.galleryService.query(
				{ text: '@category:"language packs"', pageSize: 50 },
				CancellationToken.None
			);
			return result.firstPage
				.filter(ext => ext.name.startsWith('vscode-language-pack'))
				.map(ext => {
					const locale =
						ext.tags.find(t => t.startsWith('lp-'))?.slice(3) ?? ext.name.replace('vscode-language-pack-', '');
					return {
						id: locale,
						label: ext.displayName ?? ext.name,
						description: ext.description,
						extensionId: ext.identifier.id,
						galleryExtension: ext
					};
				});
		} catch {
			return [];
		}
	}

	async getInstalledLanguages(): Promise<ILanguagePackItem[]> {
		const items: ILanguagePackItem[] = [];
		const seen = new Set<string>();

		// Check localStorage for explicitly set locale
		const extensionId = localStorage.getItem('vscode.nls.languagePackExtensionId');
		const locale = localStorage.getItem('vscode.nls.locale');

		if (extensionId && locale) {
			items.push({
				id: locale,
				label: this.getLanguageLabel(locale),
				extensionId
			});
			seen.add(locale.toLowerCase());
		}

		// Also scan installed extensions for language packs
		try {
			const extensions = this.extensionService.extensions;
			for (const ext of extensions) {
				if (ext.identifier && ext.name.startsWith('vscode-language-pack-')) {
					const extLocale = this.getLocaleFromExtensionName(ext.name);
					if (extLocale && !seen.has(extLocale.toLowerCase())) {
						items.push({
							id: extLocale,
							label: this.getLanguageLabel(extLocale),
							extensionId: ext.identifier.value
						});
						seen.add(extLocale.toLowerCase());
					}
				}
			}
		} catch {
			// ignore errors scanning extensions
		}

		return items;
	}

	private getLanguageLabel(locale: string): string {
		const labels: Record<string, string> = {
			'zh-cn': '中文(简体)',
			'zh-tw': '中文(繁體)',
			ja: '日本語',
			ko: '한국어',
			de: 'Deutsch',
			fr: 'Français',
			es: 'Español',
			it: 'Italiano',
			'pt-br': 'Português (Brasil)',
			ru: 'Русский',
			tr: 'Türkçe',
			pl: 'Polski',
			cs: 'Čeština',
			hu: 'Magyar'
		};
		return labels[locale.toLowerCase()] ?? locale;
	}

	// Map extension name suffixes to locale codes
	// e.g. vscode-language-pack-zh-hans -> zh-cn
	private getLocaleFromExtensionName(name: string): string | undefined {
		const nameToLocale: Record<string, string> = {
			'zh-hans': 'zh-cn',
			'zh-hant': 'zh-tw',
			'pt-br': 'pt-br'
		};
		const suffix = name.replace('vscode-language-pack-', '');
		return nameToLocale[suffix] ?? suffix;
	}
}
