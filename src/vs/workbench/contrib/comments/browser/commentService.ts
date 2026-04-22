/*---------------------------------------------------------------------------------------------
 *  SideX: Stub for removed comments service.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface ICommentController {
	id: string;
	label: string;
	features: {};
}

export const ICommentService = createDecorator<ICommentService>('commentService');
export interface ICommentService {
	readonly _serviceBrand: undefined;
	readonly onDidSetResourceCommentInfos: Event<unknown>;
	readonly onDidSetAllCommentThreads: Event<unknown>;
	readonly onDidUpdateCommentThreads: Event<unknown>;
	readonly onDidChangeActiveEditingCommentThread: Event<unknown>;
	readonly onDidSetDataProvider: Event<void>;
	readonly onDidDeleteDataProvider: Event<string | undefined>;
	readonly onDidChangeCommentingEnabled: Event<boolean>;
	registerCommentController(id: string, controller: ICommentController): void;
	unregisterCommentController(id?: string): void;
	updateComments(ownerId: string, event: any): void;
	updateNotebookComments(ownerId: string, event: any): void;
	updateCommentingRanges(...args: any[]): void;
	setWorkspaceComments(...args: any[]): void;
	onResourceHasCommentingRanges(...args: any[]): any;
}
