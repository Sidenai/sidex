/*---------------------------------------------------------------------------------------------
 *  Sidex Complete — Telemetry service for the DPO training pipeline.
 *
 *  Tracks completion events (shown, accepted, rejected), buffers them in memory,
 *  and flushes batches to the Go backend.  Events are also logged to the console
 *  for local observability until the server endpoint is live.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

const BUFFER_MAX = 1_000;
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface CompletionEvent {
	readonly id: string;
	readonly timestamp: number;
	readonly prompt: { prefix: string; suffix: string; language: string };
	readonly completion: string;
	accepted: boolean;
	readonly latencyMs: number;
	readonly confidence: number;
	readonly tokensGenerated: number;
}

export interface ISidexTelemetryService {
	readonly _serviceBrand: undefined;

	logShown(event: Omit<CompletionEvent, 'accepted'>): string;
	logOutcome(eventId: string, accepted: boolean): void;
	getRecentEvents(count: number): readonly CompletionEvent[];
	flush(): Promise<void>;
	dispose(): void;
}

export const ISidexTelemetryService = createDecorator<ISidexTelemetryService>('sidexTelemetryService');

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SidexTelemetryService extends Disposable implements ISidexTelemetryService {
	declare readonly _serviceBrand: undefined;

	private readonly _buffer: CompletionEvent[] = [];
	private readonly _idIndex = new Map<string, CompletionEvent>();
	private readonly _serverUrl: string;

	private _flushTimer: ReturnType<typeof setInterval> | undefined;
	private _idCounter = 0;
	private _flushing = false;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		this._serverUrl = configurationService.getValue<string>('sidex.complete.serverUrl') || '';
		this._flushTimer = setInterval(() => { this._backgroundFlush(); }, FLUSH_INTERVAL_MS);
	}

	// ------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------

	logShown(event: Omit<CompletionEvent, 'accepted'>): string {
		const id = event.id || this._generateId();
		const entry: CompletionEvent = { ...event, id, accepted: false };

		if (this._buffer.length >= BUFFER_MAX) {
			this._buffer.shift();
			const oldest = this._buffer[0];
			if (oldest) {
				this._idIndex.delete(oldest.id);
			}
		}

		this._buffer.push(entry);
		this._idIndex.set(id, entry);

		console.log('[sidex-telemetry] shown', { id, language: entry.prompt.language, latencyMs: entry.latencyMs, confidence: entry.confidence });
		return id;
	}

	logOutcome(eventId: string, accepted: boolean): void {
		const entry = this._idIndex.get(eventId);
		if (entry) {
			entry.accepted = accepted;
			console.log('[sidex-telemetry] outcome', { id: eventId, accepted });
		}
	}

	getRecentEvents(count: number): readonly CompletionEvent[] {
		return this._buffer.slice(-count);
	}

	async flush(): Promise<void> {
		await this._sendBatch(this._drainBuffer());
	}

	override dispose(): void {
		if (this._flushTimer) {
			clearInterval(this._flushTimer);
			this._flushTimer = undefined;
		}
		this._backgroundFlush();
		super.dispose();
	}

	// ------------------------------------------------------------------
	// Internals
	// ------------------------------------------------------------------

	private _generateId(): string {
		return `sc_${Date.now().toString(36)}_${(this._idCounter++).toString(36)}`;
	}

	private _backgroundFlush(): void {
		if (this._flushing) {
			return;
		}
		const batch = this._drainBuffer();
		if (batch.length === 0) {
			return;
		}
		this._sendBatch(batch).catch(() => {
			this._buffer.unshift(...batch);
			for (const e of batch) {
				this._idIndex.set(e.id, e);
			}
		});
	}

	private _drainBuffer(): CompletionEvent[] {
		const batch = this._buffer.splice(0, FLUSH_BATCH_SIZE);
		for (const e of batch) {
			this._idIndex.delete(e.id);
		}
		return batch;
	}

	private async _sendBatch(events: CompletionEvent[]): Promise<void> {
		if (events.length === 0 || !this._serverUrl) {
			return;
		}
		this._flushing = true;
		try {
			const resp = await fetch(`${this._serverUrl}/v1/telemetry`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ events }),
			});
			if (!resp.ok) {
				throw new Error(`telemetry flush failed: ${resp.status}`);
			}
			console.log(`[sidex-telemetry] flushed ${events.length} events`);
		} catch (err) {
			console.warn('[sidex-telemetry] flush failed, re-enqueuing', err);
			throw err;
		} finally {
			this._flushing = false;
		}
	}
}
