import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as createProbe } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

function controlDirectory(create: boolean): string | undefined {
	if (!process.getuid) throw new Error("TTY control requires a POSIX host");
	// Use a stable, short path across shells with different HOME/TMPDIR values.
	const directory = `/tmp/dm-tty-${process.getuid()}`;
	try {
		if (create) {
			try { mkdirSync(directory, { mode: 0o700 }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		}
		const info = lstatSync(directory);
		if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
			throw new Error("Unsafe TTY control directory; expected an owner-only directory");
		}
		return directory;
	} catch (error) {
		if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Local OS-user authority only: never expose service control on the browser HTTP port. */
export async function startTtyControl(port: number, stop: () => Promise<void>): Promise<() => void> {
	const path = join(controlDirectory(true)!, `${port}-${process.pid}-${randomBytes(8).toString("hex")}.sock`);
	const server = createServer((incoming, response) => {
		response.setHeader("connection", "close");
		if (incoming.method !== "POST" || incoming.url !== "/stop") {
			response.writeHead(404).end();
			return;
		}
		void stop().then(() => response.end("dm-tty stopped\n"), () => response.writeHead(500).end("Stop failed"));
	});
	server.maxConnections = 4;
	server.requestTimeout = 2_000;
	server.headersTimeout = 2_000;
	server.setTimeout(10_000, (socket) => socket.destroy());
	try {
		await new Promise<void>((done, reject) => {
			server.once("error", reject);
			server.listen(path, () => { server.off("error", reject); done(); });
		});
		chmodSync(path, 0o600);
	} catch (error) {
		server.close();
		throw error;
	}
	return () => {
		// Do not await the control response that is itself waiting for PTY/HTTP cleanup.
		// Bun can leave the socket file behind; remove only our unique path.
		server.close();
		server.closeIdleConnections();
		try { unlinkSync(path); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	};
}

async function stopSocket(path: string): Promise<boolean> {
	return new Promise((done, reject) => {
		const call = request({ socketPath: path, path: "/stop", method: "POST", agent: false }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
				if (body.length > 128) call.destroy(new Error("Invalid TTY control response"));
			});
			response.on("error", reject);
			response.on("end", () => {
				if (response.statusCode === 200 && body === "dm-tty stopped\n") done(true);
				else reject(new Error("TTY service did not confirm shutdown"));
			});
		});
		const timeout = setTimeout(() => call.destroy(new Error("TTY shutdown timed out")), 10_000);
		call.on("close", () => clearTimeout(timeout));
		call.on("error", (error: NodeJS.ErrnoException) => {
			// Old socket files after SIGKILL are not evidence of a live service.
			// Bun reports FailedToOpenSocket for a closed Unix listener. The
			// final TCP port probe still prevents a false shutdown confirmation.
			if (["ENOENT", "ECONNREFUSED", "FailedToOpenSocket"].includes(error.code ?? "")) done(false);
			else reject(error);
		});
		call.end();
	});
}

export async function ttyPortOccupied(port: number): Promise<boolean> {
	// On macOS a wildcard bind can succeed even while 127.0.0.1 owns the port.
	const addresses = new Set(["127.0.0.1", "::1"]);
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) addresses.add(entry.address);
	}
	for (const host of addresses) {
		const occupied = await new Promise<boolean>((done, reject) => {
			const probe = createProbe();
			probe.once("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "EADDRINUSE") done(true);
				else if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code ?? "")) done(false);
				else reject(error);
			});
			probe.listen({ port, host, ipv6Only: true }, () => probe.close(() => done(false)));
		});
		if (occupied) return true;
	}
	return false;
}

export async function stopTtyServices(port: number): Promise<number> {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid TTY control port");
	const directory = controlDirectory(false);
	let stopped = 0;
	if (directory) {
		const pattern = new RegExp(`^${port}-\\d+-[a-f0-9]{16}\\.sock$`);
		for (const name of readdirSync(directory).filter((entry) => pattern.test(entry))) {
			const path = join(directory, name);
			try {
				const info = lstatSync(path);
				if (!info.isSocket() || info.uid !== process.getuid!() || (info.mode & 0o077)) continue;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (await stopSocket(path)) stopped++;
		}
	}
	if (await ttyPortOccupied(port)) {
		throw new Error(`Port ${port} is still occupied by an unmanaged listener; no unrelated process was killed. Older DM TTY services must be stopped in their owning terminal and restarted with this version.`);
	}
	return stopped;
}
