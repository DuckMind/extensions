"""Small POSIX PTY worker. stdin/stdout carry bounded newline-delimited JSON."""

import codecs
import errno
import fcntl
import json
import os
import select
import signal
import struct
import sys
import termios
import time

MAX_LINE = 256 * 1024
MAX_FRAME = 16 * 1024
TERM_GRACE = 0.5


class StopBridge(Exception):
    pass


def stop(_signum, _frame):
    raise StopBridge()


def send(message):
    data = (json.dumps(message, ensure_ascii=True) + "\n").encode("ascii")
    while data:
        data = data[os.write(1, data):]


def signal_group(pgid, sig):
    if pgid:
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass


def foreground(master, fallback):
    try:
        return os.tcgetpgrp(master)
    except OSError:
        return fallback


def launch(program, args, cwd, master, slave):
    read_fd, write_fd = os.pipe()  # close-on-exec: EOF confirms exec succeeded
    pid = os.fork()
    if pid == 0:
        try:
            os.close(read_fd)
            os.close(master)
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            if slave > 2:
                os.close(slave)
            os.chdir(cwd)
            env = os.environ.copy()
            env.pop("DM_TTY_TOKEN", None)
            # The browser renderer is xterm, regardless of DM's parent terminal.
            env["TERM"] = "xterm-256color"
            os.execvpe(program, [program, *args], env)
        except BaseException as exc:
            try:
                os.write(write_fd, str(exc).encode("utf-8", "replace")[:4096])
            except OSError:
                pass
            os._exit(127)
    os.close(write_fd)
    os.close(slave)
    try:
        # Deadline also protects against a child blocked before exec.
        deadline = time.monotonic() + 5
        failure = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([read_fd], [], [], remaining)[0]:
                raise RuntimeError("shell exec timed out")
            part = os.read(read_fd, 4096)
            if not part:
                break
            failure.extend(part)
            if len(failure) > 4096:
                raise RuntimeError("shell exec failed")
        if failure:
            raise RuntimeError("shell exec failed: " + failure.decode("utf-8", "replace"))
        return pid
    except BaseException:
        # Before exec there is no job tree; the child may not have set its PGID.
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
        raise
    finally:
        os.close(read_fd)


def reap(pid):
    if not pid:
        return None
    try:
        finished, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return None
    if finished:
        return (os.waitstatus_to_exitcode(status), None) if os.WIFEXITED(status) else (
            None, signal.Signals(os.WTERMSIG(status)).name if os.WIFSIGNALED(status) else None
        )
    return None


def cleanup(pid, master, last_foreground, mode):
    child_reaped = False
    if pid:
        try:
            child_reaped = os.waitpid(pid, os.WNOHANG)[0] == pid
        except ChildProcessError:
            child_reaped = True
    groups = {pid} if mode == "mux" else {pid, last_foreground}
    if master is not None and mode != "mux":
        groups.add(foreground(master, pid))
    if child_reaped:
        groups.discard(pid)
    groups.discard(None)
    for group in groups:
        signal_group(group, signal.SIGTERM)
    deadline = time.monotonic() + TERM_GRACE
    while pid and not child_reaped and time.monotonic() < deadline:
        try:
            finished = os.waitpid(pid, os.WNOHANG)[0] == pid
        except ChildProcessError:
            finished = True
        if finished:
            child_reaped = True
            break
        time.sleep(0.02)
    for group in groups:
        signal_group(group, signal.SIGKILL)
    # The attachment child may have changed process group since it was launched.
    # Kill only our direct child as a fallback; never wait forever for it.
    if pid and not child_reaped:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + TERM_GRACE
        while time.monotonic() < deadline:
            try:
                finished = os.waitpid(pid, os.WNOHANG)[0] == pid
            except ChildProcessError:
                finished = True
            if finished:
                break
            time.sleep(0.02)
    if master is not None:
        os.close(master)


def bridge(mode, program, cwd, args):
    master = None
    pid = None
    last_foreground = None
    try:
        master, slave = os.openpty()
        pid = launch(program, args, cwd, master, slave)
        last_foreground = pid
        send({"type": "ready", "pid": pid})
        pending = bytearray()
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        alive = True
        result = None
        while True:
            last_foreground = foreground(master, last_foreground)
            if alive:
                status = reap(pid)
                if status is not None:
                    result = status
                    alive = False
            ready, _, _ = select.select([0, master], [], [], 0.05)
            if 0 in ready:
                part = os.read(0, MAX_FRAME)
                if not part:
                    break
                pending.extend(part)
                if len(pending) > MAX_LINE:
                    raise ValueError("PTY input frame exceeds 256 KiB")
                while b"\n" in pending:
                    line, _, remainder = pending.partition(b"\n")
                    pending = bytearray(remainder)
                    if len(line) > MAX_LINE:
                        raise ValueError("PTY input frame exceeds 256 KiB")
                    msg = json.loads(line)
                    if not isinstance(msg, dict):
                        raise ValueError("invalid PTY command")
                    if msg.get("type") == "input" and isinstance(msg.get("data"), str):
                        data = msg["data"].encode("utf-8")
                        if len(data) > MAX_LINE:
                            raise ValueError("PTY input exceeds 256 KiB")
                        # A PTY can have a small input buffer; do not block indefinitely.
                        os.set_blocking(master, False)
                        try:
                            while data:
                                _, writable, _ = select.select([], [master], [], 1)
                                if not writable:
                                    raise TimeoutError("PTY input stalled")
                                data = data[os.write(master, data):]
                        finally:
                            os.set_blocking(master, True)
                    elif msg.get("type") == "resize":
                        cols, rows = msg.get("cols"), msg.get("rows")
                        if type(cols) is not int or type(rows) is not int or not (2 <= cols <= 500 and 1 <= rows <= 200):
                            raise ValueError("invalid PTY dimensions")
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                        signal_group(foreground(master, pid), signal.SIGWINCH)
                    else:
                        raise ValueError("invalid PTY command")
            if master in ready:
                try:
                    data = os.read(master, MAX_FRAME)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    data = b""
                if data:
                    text = decoder.decode(data)
                    if text:
                        send({"type": "output", "data": text})
                else:
                    tail = decoder.decode(b"", final=True)
                    if tail:
                        send({"type": "output", "data": tail})
                    if alive:
                        # Closing the master does not guarantee the child has exited.
                        # Give a normally exiting shell time to report its status,
                        # but never block indefinitely before cleanup on EOF.
                        deadline = time.monotonic() + 0.2
                        while result is None and time.monotonic() < deadline:
                            result = reap(pid)
                            if result is None:
                                time.sleep(0.01)
                    send({"type": "exit", "code": result[0] if result else None, "signal": result[1] if result else None})
                    return
    except StopBridge:
        pass
    except (Exception, OSError) as exc:
        try:
            send({"type": "error", "message": str(exc)})
        except (OSError, StopBridge):
            pass
    finally:
        cleanup(pid, master, last_foreground, mode)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if len(sys.argv) < 4 or sys.argv[1] not in ("shell", "mux"):
        sys.exit("usage: pty_bridge.py MODE PROGRAM CWD [ARGS...]")
    bridge(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:])
