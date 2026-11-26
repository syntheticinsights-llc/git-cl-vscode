import type { WebviewMessage } from '../board/protocol';

export interface BoardPersistedState {
	selected?: string;
	collapsed?: string[];
}

interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
	getState(): BoardPersistedState | undefined;
	setState(state: BoardPersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscodeApi = acquireVsCodeApi();
