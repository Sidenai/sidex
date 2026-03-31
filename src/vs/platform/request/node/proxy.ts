/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type Agent = any;

export interface IOptions {
	proxyUrl?: string;
	strictSSL?: boolean;
}

export async function getProxyAgent(rawRequestURL: string, env: Record<string, string | undefined>, options: IOptions = {}): Promise<Agent> {
	// In Tauri, HTTP requests go through the Rust backend or fetch API.
	// Proxy configuration is handled at the system/Tauri level.
	// Return null to let the default handler manage proxies.
	return null;
}
