/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal } from '@xterm/xterm';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ShellIntegrationAddon } from '../../../../../../platform/terminal/common/xterm/shellIntegrationAddon.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { getActiveDocument } from '../../../../../../base/browser/dom.js';
import { strictEqual } from 'assert';
import { importAMDNodeModule } from '../../../../../../amdX.js';
import { InitialHintAddon } from '../../browser/terminal.initialHint.contribution.js';
import { TestXtermLogger } from '../../../../../../platform/terminal/test/common/terminalTestHelpers.js';

suite('Terminal Initial Hint Addon', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let eventCount = 0;
	let xterm: Terminal;
	let initialHintAddon: InitialHintAddon;
	setup(async () => {
		const instantiationService = workbenchInstantiationService({}, store);
		const TerminalCtor = (await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js')).Terminal;
		xterm = store.add(new TerminalCtor({ logger: TestXtermLogger }));
		const shellIntegrationAddon = store.add(new ShellIntegrationAddon('', true, undefined, undefined, new NullLogService));
		initialHintAddon = store.add(instantiationService.createInstance(InitialHintAddon, shellIntegrationAddon.capabilities));
		store.add(initialHintAddon.onDidRequestCreateHint(() => eventCount++));
		const testContainer = document.createElement('div');
		getActiveDocument().body.append(testContainer);
		xterm.open(testContainer);

		xterm.loadAddon(shellIntegrationAddon);
		xterm.loadAddon(initialHintAddon);
	});

	test('hint is not shown initially without command detection', () => {
		eventCount = 0;
		xterm.focus();
		strictEqual(eventCount, 0);
	});
});
