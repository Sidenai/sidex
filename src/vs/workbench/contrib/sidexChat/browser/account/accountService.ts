/*---------------------------------------------------------------------------------------------
 *  Account Service — local identity for the chat UI.
 *
 *  SideX has no sign-in. This service exists so the chat UI has one place to
 *  ask "who is this", and it answers from the local machine: the profile
 *  comes from the OS user, via Rust's `auth_get_session`.
 *
 *  The session it hands out deliberately carries no access token. Callers that
 *  used to gate on a token now gate on nothing, because there is no remote
 *  service to authenticate against.
 *
 *  Usage/spend totals are deliberately NOT surfaced here. This service used to
 *  poll Rust's `auth_get_usage` on a 60s interval and re-expose it as
 *  `getUsageSummary()` / `onDidChangeUsage`, but nothing in the workbench ever
 *  called either — Settings → Usage (`sections/planUsageSection.ts`) fetches
 *  the same command directly, once, when that section renders. That left a
 *  singleton-lifetime timer doing a Tauri round trip every 60s for a value no
 *  code ever read, so it was removed rather than kept "just in case".
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';

export interface IUserProfile {
	id: string;
	email: string;
	name: string;
	picture: string | null;
}

export interface IAuthSession {
	/** Always empty — the local server needs no bearer token. */
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number;
	user: IUserProfile;
}

/** Shown when the Rust side is unreachable, e.g. a browser dev session. */
const FALLBACK_PROFILE: IUserProfile = {
	id: 'local',
	email: '',
	name: 'You',
	picture: null,
};

export const IAccountService = createDecorator<IAccountService>('accountService');

export interface IAccountService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSession: Event<IAuthSession | null>;

	getSession(): IAuthSession | null;
	refreshToken(): Promise<void>;
	isLoggedIn(): boolean;
	getAccessToken(): string | null;
}

export class AccountService extends Disposable implements IAccountService {
	declare readonly _serviceBrand: undefined;

	private _session: IAuthSession;

	private readonly _onDidChangeSession = this._register(new Emitter<IAuthSession | null>());
	readonly onDidChangeSession = this._onDidChangeSession.event;

	constructor() {
		super();
		// Start from a usable session so the panel renders on first paint; the
		// real profile replaces it as soon as Rust answers.
		this._session = {
			accessToken: '',
			refreshToken: null,
			expiresAt: 0,
			user: FALLBACK_PROFILE,
		};
		void this._loadProfile();
	}

	getSession(): IAuthSession | null {
		return this._session;
	}

	/** Always true: there is no signed-out state to be in. */
	isLoggedIn(): boolean {
		return true;
	}

	/**
	 * Always null. The agent server listens on loopback and serves only the
	 * local user, so nothing is bearer-authenticated.
	 */
	getAccessToken(): string | null {
		return null;
	}

	/** No token to refresh; re-reads the local profile instead. */
	async refreshToken(): Promise<void> {
		await this._loadProfile();
	}

	private async _loadProfile(): Promise<void> {
		const invoke = AccountService._getTauriInvoke();
		if (!invoke) {
			return;
		}
		try {
			const session = await invoke('auth_get_session') as IAuthSession | null;
			if (session?.user) {
				this._session = session;
				this._onDidChangeSession.fire(session);
			}
		} catch {
			// Keep the fallback profile; nothing here is load-bearing.
		}
	}

	private static _getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
		const g = globalThis as unknown as {
			__TAURI_INVOKE__?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
			__TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
		};
		return g.__TAURI_INVOKE__ ?? g.__TAURI_INTERNALS__?.invoke ?? null;
	}
}

registerSingleton(IAccountService, AccountService, InstantiationType.Delayed);
