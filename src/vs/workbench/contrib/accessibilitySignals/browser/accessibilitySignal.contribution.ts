import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import {
	IAccessibilitySignalService,
	AccessibilitySignalService
} from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';

registerSingleton(IAccessibilitySignalService, AccessibilitySignalService, InstantiationType.Delayed);
