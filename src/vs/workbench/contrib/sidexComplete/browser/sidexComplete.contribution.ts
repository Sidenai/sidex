/*---------------------------------------------------------------------------------------------
 *  Sidex Complete — Registers the FIM inline-completion provider.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { SidexCompleteProvider } from './sidexCompleteProvider.js';
import { resolveServerEndpoint, serverHttpUrl } from '../../sidexChat/browser/localServer.js';

class SidexCompleteContribution implements IWorkbenchContribution {
	static readonly ID = 'sidex.complete';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		// Defaults to the agent server the app runs locally; an explicit
		// setting points completions somewhere else. Registration waits for
		// the port to be known, but the URL is re-read per request so a server
		// restart doesn't strand the provider on a dead port.
		const resolveUrl = () => serverHttpUrl(configurationService.getValue<string>('sidex.complete.serverUrl'));
		void resolveServerEndpoint().then(() => {
			const provider = new SidexCompleteProvider(resolveUrl);
			languageFeaturesService.inlineCompletionsProvider.register('*', provider);
		});
	}
}

registerWorkbenchContribution2(SidexCompleteContribution.ID, SidexCompleteContribution, WorkbenchPhase.AfterRestored);
