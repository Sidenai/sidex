export interface OpenPath {
	path: string;
	kind: 'file' | 'folder' | 'workspace';
}

export interface OpenPathsHost {
	take(): Promise<OpenPath[] | null>;
	load(): OpenPath[] | null;
	save(paths: OpenPath[]): void;
	clear(): void;
	openWorkspace(path: OpenPath): boolean;
	openFile(path: string): Promise<void>;
	onError(error: unknown): void;
}

/** Serialize wake-ups; keep the current launch across a workspace reload. */
export function createOpenPathsHandler(host: OpenPathsHost): () => Promise<void> {
	let chain = Promise.resolve();
	let navigating = false;
	return () => {
		chain = chain
			.then(async () => {
				while (!navigating) {
					const paths = host.load() ?? (await host.take());
					if (!paths) {
						return;
					}
					host.save(paths);
					// A window has one workspace. For multiple roots, the last one wins.
					const workspace = paths.filter(path => path.kind !== 'file').pop();
					if (workspace && host.openWorkspace(workspace)) {
						navigating = true;
						return;
					}
					for (const path of paths) {
						if (path.kind === 'file') {
							try {
								await host.openFile(path.path);
							} catch (error) {
								host.onError(error);
							}
						}
					}
					host.clear();
				}
			})
			.catch(error => host.onError(error));
		return chain;
	};
}
