/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogMessage, IRecursiveWatcherWithSubscribe, IUniversalWatchRequest, IWatchRequestWithCorrelation, IWatcher, IWatcherErrorEvent, isWatchRequestWithCorrelation, requestFilterToString } from '../../common/watcher.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { FileChangeType, IFileChange } from '../../common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { DeferredPromise, ThrottledDelayer } from '../../../../base/common/async.js';
import { hash } from '../../../../base/common/hash.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';

interface ISuspendedWatchRequest {
	readonly id: number;
	readonly correlationId: number | undefined;
	readonly path: string;
}

export abstract class BaseWatcher extends Disposable implements IWatcher {

	protected readonly _onDidChangeFile = this._register(new Emitter<IFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	protected readonly _onDidLogMessage = this._register(new Emitter<ILogMessage>());
	readonly onDidLogMessage = this._onDidLogMessage.event;

	protected readonly _onDidWatchFail = this._register(new Emitter<IUniversalWatchRequest>());
	private readonly onDidWatchFail = this._onDidWatchFail.event;

	private readonly correlatedWatchRequests = new Map<number /* request ID */, IWatchRequestWithCorrelation>();
	private readonly nonCorrelatedWatchRequests = new Map<number /* request ID */, IUniversalWatchRequest>();

	private readonly suspendedWatchRequests = this._register(new DisposableMap<number /* request ID */>());
	private readonly suspendedWatchRequestsWithPolling = new Set<number /* request ID */>();

	private readonly updateWatchersDelayer = this._register(new ThrottledDelayer<void>(this.getUpdateWatchersDelay()));

	protected readonly suspendedWatchRequestPollingInterval: number = 5007; // node.js default

	private joinWatch = new DeferredPromise<void>();

	constructor() {
		super();

		this._register(this.onDidWatchFail(request => this.suspendWatchRequest({
			id: this.computeId(request),
			correlationId: this.isCorrelated(request) ? request.correlationId : undefined,
			path: request.path
		})));
	}

	protected isCorrelated(request: IUniversalWatchRequest): request is IWatchRequestWithCorrelation {
		return isWatchRequestWithCorrelation(request);
	}

	private computeId(request: IUniversalWatchRequest): number {
		if (this.isCorrelated(request)) {
			return request.correlationId;
		} else {
			// Requests without correlation do not carry any unique identifier, so we have to
			// come up with one based on the options of the request. This matches what the
			// file service does (vs/platform/files/common/fileService.ts#L1178).
			return hash(request);
		}
	}

	async watch(requests: IUniversalWatchRequest[]): Promise<void> {
		if (!this.joinWatch.isSettled) {
			this.joinWatch.complete();
		}
		this.joinWatch = new DeferredPromise<void>();

		try {
			this.correlatedWatchRequests.clear();
			this.nonCorrelatedWatchRequests.clear();

			// Figure out correlated vs. non-correlated requests
			for (const request of requests) {
				if (this.isCorrelated(request)) {
					this.correlatedWatchRequests.set(request.correlationId, request);
				} else {
					this.nonCorrelatedWatchRequests.set(this.computeId(request), request);
				}
			}

			// Remove all suspended watch requests that are no longer watched
			for (const [id] of this.suspendedWatchRequests) {
				if (!this.nonCorrelatedWatchRequests.has(id) && !this.correlatedWatchRequests.has(id)) {
					this.suspendedWatchRequests.deleteAndDispose(id);
					this.suspendedWatchRequestsWithPolling.delete(id);
				}
			}

			return await this.updateWatchers(false /* not delayed */);
		} finally {
			this.joinWatch.complete();
		}
	}

	private updateWatchers(delayed: boolean): Promise<void> {
		const nonSuspendedRequests: IUniversalWatchRequest[] = [];
		for (const [id, request] of [...this.nonCorrelatedWatchRequests, ...this.correlatedWatchRequests]) {
			if (!this.suspendedWatchRequests.has(id)) {
				nonSuspendedRequests.push(request);
			}
		}

		return this.updateWatchersDelayer.trigger(() => this.doWatch(nonSuspendedRequests), delayed ? this.getUpdateWatchersDelay() : 0).catch(error => onUnexpectedError(error));
	}

	protected getUpdateWatchersDelay(): number {
		return 800;
	}

	isSuspended(request: IUniversalWatchRequest): 'polling' | boolean {
		const id = this.computeId(request);
		return this.suspendedWatchRequestsWithPolling.has(id) ? 'polling' : this.suspendedWatchRequests.has(id);
	}

	private async suspendWatchRequest(request: ISuspendedWatchRequest): Promise<void> {
		if (this.suspendedWatchRequests.has(request.id)) {
			return; // already suspended
		}

		const disposables = new DisposableStore();
		this.suspendedWatchRequests.set(request.id, disposables);

		// It is possible that a watch request fails right during watch()
		// phase while other requests succeed. To increase the chance of
		// reusing another watcher for suspend/resume tracking, we await
		// all watch requests having processed.

		await this.joinWatch.p;

		if (disposables.isDisposed) {
			return;
		}

		this.monitorSuspendedWatchRequest(request, disposables);

		this.updateWatchers(true /* delay this call as we might accumulate many failing watch requests on startup */);
	}

	private resumeWatchRequest(request: ISuspendedWatchRequest): void {
		this.suspendedWatchRequests.deleteAndDispose(request.id);
		this.suspendedWatchRequestsWithPolling.delete(request.id);

		this.updateWatchers(false);
	}

	private monitorSuspendedWatchRequest(request: ISuspendedWatchRequest, disposables: DisposableStore): void {
		if (this.doMonitorWithExistingWatcher(request, disposables)) {
			this.trace(`reusing an existing recursive watcher to monitor ${request.path}`);
			this.suspendedWatchRequestsWithPolling.delete(request.id);
		} else {
			this.doMonitorWithNodeJS(request, disposables);
			this.suspendedWatchRequestsWithPolling.add(request.id);
		}
	}

	private doMonitorWithExistingWatcher(request: ISuspendedWatchRequest, disposables: DisposableStore): boolean {
		const subscription = this.recursiveWatcher?.subscribe(request.path, (error, change) => {
			if (disposables.isDisposed) {
				return; // return early if already disposed
			}

			if (error) {
				this.monitorSuspendedWatchRequest(request, disposables);
			} else if (change?.type === FileChangeType.ADDED) {
				this.onMonitoredPathAdded(request);
			}
		});

		if (subscription) {
			disposables.add(subscription);

			return true;
		}

		return false;
	}

	private doMonitorWithNodeJS(request: ISuspendedWatchRequest, disposables: DisposableStore): void {
		let pathNotFound = false;
		let pollingHandle: ReturnType<typeof setInterval> | undefined;

		this.trace(`starting polling watch on ${request.path} (correlationId: ${request.correlationId})`);

		const checkPath = async () => {
			if (disposables.isDisposed) {
				return;
			}

			try {
				const exists = await invoke<boolean>('fs_exists', { path: request.path });
				const oldPathNotFound = pathNotFound;
				pathNotFound = !exists;

				if (exists && oldPathNotFound) {
					this.onMonitoredPathAdded(request);
				}
			} catch {
				pathNotFound = true;
			}
		};

		try {
			pollingHandle = setInterval(checkPath, this.suspendedWatchRequestPollingInterval);
			checkPath();
		} catch (error) {
			this.warn(`polling watch failed with error ${error} on path ${request.path} (correlationId: ${request.correlationId})`);
		}

		disposables.add(toDisposable(() => {
			this.trace(`stopping polling watch on ${request.path} (correlationId: ${request.correlationId})`);
			if (pollingHandle !== undefined) {
				clearInterval(pollingHandle);
			}
		}));
	}

	private onMonitoredPathAdded(request: ISuspendedWatchRequest): void {
		this.trace(`detected ${request.path} exists again, resuming watcher (correlationId: ${request.correlationId})`);

		// Emit as event
		const event: IFileChange = { resource: URI.file(request.path), type: FileChangeType.ADDED, cId: request.correlationId };
		this._onDidChangeFile.fire([event]);
		this.traceEvent(event, request);

		// Resume watching
		this.resumeWatchRequest(request);
	}

	private isPathNotFound(stats: Stats): boolean {
		return stats.ctimeMs === 0 && stats.ino === 0;
	}

	async stop(): Promise<void> {
		this.suspendedWatchRequests.clearAndDisposeAll();
		this.suspendedWatchRequestsWithPolling.clear();
	}

	protected traceEvent(event: IFileChange, request: IUniversalWatchRequest | ISuspendedWatchRequest): void {
		if (this.verboseLogging) {
			const traceMsg = ` >> normalized ${event.type === FileChangeType.ADDED ? '[ADDED]' : event.type === FileChangeType.DELETED ? '[DELETED]' : '[CHANGED]'} ${event.resource.fsPath}`;
			this.traceWithCorrelation(traceMsg, request);
		}
	}

	protected traceWithCorrelation(message: string, request: IUniversalWatchRequest | ISuspendedWatchRequest): void {
		if (this.verboseLogging) {
			this.trace(`${message}${typeof request.correlationId === 'number' ? ` <${request.correlationId}> ` : ``}`);
		}
	}

	protected requestToString(request: IUniversalWatchRequest): string {
		return `${request.path} (excludes: ${request.excludes.length > 0 ? request.excludes : '<none>'}, includes: ${request.includes && request.includes.length > 0 ? JSON.stringify(request.includes) : '<all>'}, filter: ${requestFilterToString(request.filter)}, correlationId: ${typeof request.correlationId === 'number' ? request.correlationId : '<none>'})`;
	}

	protected abstract doWatch(requests: IUniversalWatchRequest[]): Promise<void>;

	protected abstract readonly recursiveWatcher: IRecursiveWatcherWithSubscribe | undefined;

	protected abstract trace(message: string): void;
	protected abstract warn(message: string): void;

	abstract onDidError: Event<IWatcherErrorEvent>;

	protected verboseLogging = false;

	async setVerboseLogging(enabled: boolean): Promise<void> {
		this.verboseLogging = enabled;
	}
}
