import { createRequire } from "node:module";
import { getDmHostModule } from "./dm-host-deps.js";

export type { CancellationToken, MessageConnection } from "vscode-jsonrpc";

const fallbackRequire = createRequire(import.meta.url);
const jsonrpc =
	getDmHostModule<typeof import("vscode-jsonrpc/node")>("vscode-jsonrpc/node") ??
	(fallbackRequire("vscode-jsonrpc/node") as typeof import("vscode-jsonrpc/node"));

export const CancellationTokenSource = jsonrpc.CancellationTokenSource;
export const createMessageConnection = jsonrpc.createMessageConnection;
export const StreamMessageReader = jsonrpc.StreamMessageReader;
export const StreamMessageWriter = jsonrpc.StreamMessageWriter;
