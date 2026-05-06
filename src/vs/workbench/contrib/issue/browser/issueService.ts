/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchIssueService } from '../common/issue.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';

export class BrowserIssueService implements IWorkbenchIssueService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IProductService private readonly productService: IProductService,
		@IOpenerService private readonly openerService: IOpenerService
	) { }

	async openReporter(dataOverrides?: any): Promise<void> {
		const issueUrl = this.productService.reportIssueUrl;
		if (issueUrl) {
			let url = issueUrl;
			if (dataOverrides && dataOverrides.issueTitle) {
				const separator = url.includes('?') ? '&' : '?';
				url += `${separator}title=${encodeURIComponent(dataOverrides.issueTitle)}`;
			}
			if (dataOverrides && dataOverrides.issueBody) {
				const separator = url.includes('?') ? '&' : '?';
				url += `${separator}body=${encodeURIComponent(dataOverrides.issueBody)}`;
			}
			await this.openerService.open(URI.parse(url));
		}
	}
}
