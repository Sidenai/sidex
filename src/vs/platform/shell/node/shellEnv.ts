/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { localize } from '../../../nls.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { IProcessEnvironment, isWindows } from '../../../base/common/platform.js';
import { NativeParsedArgs } from '../../environment/common/argv.js';
import { isLaunchedFromCli } from '../../environment/node/argvHelper.js';
import { ILogService } from '../../log/common/log.js';
import { Promises } from '../../../base/common/async.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { clamp } from '../../../base/common/numbers.js';

let unixShellEnvPromise: Promise<IProcessEnvironment> | undefined = undefined;

export async function getResolvedShellEnv(configurationService: IConfigurationService, logService: ILogService, args: NativeParsedArgs, env: IProcessEnvironment): Promise<IProcessEnvironment> {

	if (args['force-disable-user-env']) {
		logService.trace('resolveShellEnv(): skipped (--force-disable-user-env)');
		return {};
	} else if (isWindows) {
		logService.trace('resolveShellEnv(): skipped (Windows)');
		return {};
	} else if (isLaunchedFromCli(env) && !args['force-user-env']) {
		logService.trace('resolveShellEnv(): skipped (VSCODE_CLI is set)');
		return {};
	} else {
		if (isLaunchedFromCli(env)) {
			logService.trace('resolveShellEnv(): running (--force-user-env)');
		} else {
			logService.trace('resolveShellEnv(): running (macOS/Linux)');
		}

		if (!unixShellEnvPromise) {
			unixShellEnvPromise = Promises.withAsyncBody<IProcessEnvironment>(async (resolve, reject) => {
				const cts = new CancellationTokenSource();

				let timeoutValue = 10000;
				const configuredTimeoutValue = configurationService.getValue<unknown>('application.shellEnvironmentResolutionTimeout');
				if (typeof configuredTimeoutValue === 'number') {
					timeoutValue = clamp(configuredTimeoutValue, 1, 120) * 1000;
				}

				const timeout = setTimeout(() => {
					cts.dispose(true);
					reject(new Error(localize('resolveShellEnvTimeout', "Unable to resolve your shell environment in a reasonable time. Please review your shell configuration and restart.")));
				}, timeoutValue);

				try {
					const shellEnv = await invoke<IProcessEnvironment>('os_resolve_shell_env');
					resolve(shellEnv);
				} catch (error) {
					if (!isCancellationError(error) && !cts.token.isCancellationRequested) {
						reject(new Error(localize('resolveShellEnvError', "Unable to resolve your shell environment: {0}", String(error))));
					} else {
						resolve({});
					}
				} finally {
					clearTimeout(timeout);
					cts.dispose();
				}
			});
		}

		return unixShellEnvPromise;
	}
}
