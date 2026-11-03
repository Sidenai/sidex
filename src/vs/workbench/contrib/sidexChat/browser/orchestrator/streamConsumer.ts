/*---------------------------------------------------------------------------------------------
 *  Sidex Stream Consumer — Async iterator with backpressure, throttling, and cancellation
 *
 *  Cursor SDK gives you `run.stream()` as an async generator. We do the same but
 *  with built-in RAF throttling for UI consumers, cancellation tokens, and typed
 *  event filtering — so you can subscribe to just tool calls, or just text, etc.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { OrchestratorEvent } from './types.js';

export interface StreamConsumerOptions {
	/** Only receive events of these types (empty = all) */
	filter?: OrchestratorEvent['type'][];
	/** Throttle UI updates to at most one per animation frame */
	throttleToFrame?: boolean;
	/** Buffer size before applying backpressure (0 = unbounded) */
	bufferSize?: number;
}

/**
 * A typed, cancellable stream consumer that wraps orchestrator events
 * into an async iterable with backpressure support.
 *
 * Usage:
 * ```ts
 * const stream = new StreamConsumer(orchestrator.onEvent, { throttleToFrame: true });
 * for await (const event of stream) {
 *   switch (event.type) { ... }
 * }
 * ```
 */
export class StreamConsumer extends Disposable implements AsyncIterable<OrchestratorEvent> {
	private _buffer: OrchestratorEvent[] = [];
	private _resolve: ((value: IteratorResult<OrchestratorEvent>) => void) | null = null;
	private _done = false;
	private _options: Required<StreamConsumerOptions>;
	private _frameQueued = false;
	private _frameBuffer: OrchestratorEvent[] = [];

	private readonly _onDrain = this._register(new Emitter<void>());
	readonly onDrain: Event<void> = this._onDrain.event;

	private readonly _onBackpressure = this._register(new Emitter<number>());
	readonly onBackpressure: Event<number> = this._onBackpressure.event;

	constructor(
		source: Event<OrchestratorEvent>,
		options?: StreamConsumerOptions,
	) {
		super();
		this._options = {
			filter: options?.filter ?? [],
			throttleToFrame: options?.throttleToFrame ?? false,
			bufferSize: options?.bufferSize ?? 1000,
		};

		this._register(source((event) => {
			if (this._done) { return; }
			if (this._options.filter.length > 0 && !this._options.filter.includes(event.type)) {
				return;
			}

			if (this._options.throttleToFrame) {
				this._frameBuffer.push(event);
				if (!this._frameQueued) {
					this._frameQueued = true;
					requestAnimationFrame(() => {
						this._frameQueued = false;
						// Deliver only the latest event of each type per frame
						const byType = new Map<string, OrchestratorEvent>();
						for (const e of this._frameBuffer) {
							byType.set(e.type, e);
						}
						this._frameBuffer = [];
						for (const e of byType.values()) {
							this._push(e);
						}
					});
				}
			} else {
				this._push(event);
			}
		}));
	}

	private _push(event: OrchestratorEvent): void {
		if (this._resolve) {
			const resolve = this._resolve;
			this._resolve = null;
			resolve({ value: event, done: false });
		} else {
			this._buffer.push(event);
			if (this._options.bufferSize > 0 && this._buffer.length >= this._options.bufferSize) {
				this._onBackpressure.fire(this._buffer.length);
			}
		}
	}

	cancel(): void {
		this._done = true;
		if (this._resolve) {
			this._resolve({ value: undefined as unknown as OrchestratorEvent, done: true });
			this._resolve = null;
		}
	}

	get buffered(): number { return this._buffer.length; }
	get isDone(): boolean { return this._done; }

	[Symbol.asyncIterator](): AsyncIterator<OrchestratorEvent> {
		return {
			next: () => {
				if (this._buffer.length > 0) {
					const value = this._buffer.shift()!;
					if (this._buffer.length === 0) {
						this._onDrain.fire();
					}
					return Promise.resolve({ value, done: false });
				}
				if (this._done) {
					return Promise.resolve({ value: undefined as unknown as OrchestratorEvent, done: true });
				}
				return new Promise<IteratorResult<OrchestratorEvent>>((resolve) => {
					this._resolve = resolve;
				});
			},
			return: () => {
				this.cancel();
				return Promise.resolve({ value: undefined as unknown as OrchestratorEvent, done: true });
			},
		};
	}
}

/**
 * Convenience: collect all events until stream completes.
 * Use only for short-lived orchestrations or testing.
 */
export async function collectStream(
	source: Event<OrchestratorEvent>,
	until: (event: OrchestratorEvent) => boolean,
): Promise<OrchestratorEvent[]> {
	const events: OrchestratorEvent[] = [];
	const stream = new StreamConsumer(source);

	for await (const event of stream) {
		events.push(event);
		if (until(event)) {
			stream.cancel();
			break;
		}
	}

	stream.dispose();
	return events;
}

/**
 * Wait for a specific event type from the stream.
 */
export function waitForEvent<T extends OrchestratorEvent>(
	source: Event<OrchestratorEvent>,
	type: T['type'],
	timeoutMs = 30_000,
): Promise<T | null> {
	return new Promise((resolve) => {
		const stream = new StreamConsumer(source, { filter: [type] });
		const timer = setTimeout(() => {
			stream.cancel();
			stream.dispose();
			resolve(null);
		}, timeoutMs);

		(async () => {
			for await (const event of stream) {
				clearTimeout(timer);
				stream.cancel();
				stream.dispose();
				resolve(event as T);
				return;
			}
		})();
	});
}
