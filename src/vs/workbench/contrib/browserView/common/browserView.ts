/*---------------------------------------------------------------------------------------------
 *  SideX: Stub for removed browser view service.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IBrowserViewCDPService = createDecorator<IBrowserViewCDPService>('browserViewCDPService');
export interface IBrowserViewCDPService {
	readonly _serviceBrand: undefined;
	createSessionGroup(...args: any[]): any;
	destroySessionGroup(...args: any[]): any;
	sendCDPMessage(...args: any[]): any;
	onCDPMessage(...args: any[]): any;
	onDidDestroy(...args: any[]): any;
}
