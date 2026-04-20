/*---------------------------------------------------------------------------------------------
 *  Stub: Language Model Tools Service
 *  Provides type definitions for chat tool integrations.
 *  The full chat module is not present in this build; this stub
 *  satisfies compile-time imports from extensions that reference it.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';

export type CountTokensCallback = (text: string, token?: CancellationToken) => Promise<number>;

export type ToolProgress = (message: string) => void;

export const enum ToolDataSource {
	Internal = 'internal',
	Extension = 'extension'
}

export interface IToolData {
	id: string;
	toolReferenceName?: string;
	legacyToolReferenceFullNames?: string[];
	canBeReferencedInPrompt?: boolean;
	icon?: unknown;
	displayName: string;
	modelDescription: string;
	userDescription: string;
	source: ToolDataSource;
	inputSchema?: Record<string, unknown>;
}

export interface IToolInvocation {
	parameters: unknown;
}

export interface IToolInvocationPreparationContext {
	parameters: unknown;
}

export interface IToolResult {
	content: { kind: string; value: string }[];
	toolResultDetails?: {
		input: string;
		output: { type: string; isText: boolean; value: string }[];
	};
}

export interface IPreparedToolInvocation {
	confirmationMessages?: {
		title: string;
		message: unknown;
	};
	toolSpecificData?: unknown;
}

export interface IToolImpl {
	prepareToolInvocation?(
		context: IToolInvocationPreparationContext,
		token: CancellationToken
	): Promise<IPreparedToolInvocation | undefined>;
	invoke(
		invocation: IToolInvocation,
		countTokens: CountTokensCallback,
		progress: ToolProgress,
		token: CancellationToken
	): Promise<IToolResult>;
}
