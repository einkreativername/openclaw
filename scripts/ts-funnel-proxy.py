#!/usr/bin/env python3
"""Loopback HTTP proxy so host Tailscale Funnel can reach OpenClaw Control UI.

Host Funnel cannot TCP-proxy to another tailnet IP (hairpin). It also injects
X-Forwarded-* and Tailscale identity headers; OpenClaw then returns 403
proxy_attribution_required on gateway-authenticated routes.

This process:
  1. Listens on 127.0.0.1 (Funnel target)
  2. Forwards to the Docker OpenClaw node over the tailnet
  3. Strips Funnel/proxy attribution headers so the Gateway sees ordinary
     tailnet traffic (token/device auth still apply)
  4. After HTTP 101, splices bytes for Control UI WebSockets
"""
from __future__ import annotations

import os
import socket
import sys
import threading

LISTEN_HOST = os.environ.get("LISTEN_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "18791"))
TARGET_HOST = os.environ.get("TARGET_HOST", "openclaw-gateway-1.tail61d6db.ts.net")
TARGET_PORT = int(os.environ.get("TARGET_PORT", "18789"))

DROP_EXACT = {
    "forwarded",
    "x-real-ip",
    "tailscale-funnel-request",
    "tailscale-headers-info",
    "tailscale-user-login",
    "tailscale-user-name",
    "tailscale-user-profile-pic",
}


def strip_attribution_headers(header_block: bytes) -> bytes:
    """Rewrite the HTTP header block; keep request line and non-attribution headers."""
    text = header_block.decode("iso-8859-1")
    lines = text.split("\r\n")
    if not lines:
        return header_block
    kept = [lines[0]]
    for line in lines[1:]:
        if not line:
            continue
        name = line.split(":", 1)[0].strip().lower()
        if name in DROP_EXACT or name.startswith("x-forwarded-"):
            continue
        kept.append(line)
    return ("\r\n".join(kept) + "\r\n\r\n").encode("iso-8859-1")


def _recv_headers(sock: socket.socket) -> bytes:
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            break
        buf += chunk
        if len(buf) > 1024 * 1024:
            break
    return buf


def _header_map(header_block: bytes) -> dict[str, str]:
    text = header_block.decode("iso-8859-1")
    out: dict[str, str] = {}
    for line in text.split("\r\n")[1:]:
        if not line or ":" not in line:
            continue
        name, value = line.split(":", 1)
        out[name.strip().lower()] = value.strip()
    return out


def _pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            src.shutdown(socket.SHUT_RD)
        except OSError:
            pass
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def _splice(a: socket.socket, b: socket.socket) -> None:
    t1 = threading.Thread(target=_pipe, args=(a, b), daemon=True)
    t2 = threading.Thread(target=_pipe, args=(b, a), daemon=True)
    t1.start()
    t2.start()
    t1.join()
    t2.join()


def _handle(client: socket.socket) -> None:
    remote: socket.socket | None = None
    try:
        incoming = _recv_headers(client)
        split_at = incoming.find(b"\r\n\r\n")
        if split_at < 0:
            return
        raw_headers = incoming[: split_at + 4]
        rest = incoming[split_at + 4 :]
        headers = _header_map(raw_headers)
        content_len = int(headers.get("content-length", "0") or "0")
        while len(rest) < content_len:
            chunk = client.recv(65536)
            if not chunk:
                break
            rest += chunk
        body, leftover = rest[:content_len], rest[content_len:]

        infos = socket.getaddrinfo(
            TARGET_HOST, TARGET_PORT, socket.AF_INET, socket.SOCK_STREAM
        )
        remote = socket.create_connection(infos[0][4], 5)
        remote.sendall(strip_attribution_headers(raw_headers) + body)
        if leftover:
            remote.sendall(leftover)

        response = _recv_headers(remote)
        client.sendall(response)
        is_ws = b" 101 " in response.split(b"\r\n", 1)[0]
        if is_ws:
            _splice(client, remote)
            return
        _splice(client, remote)
    except Exception as err:
        sys.stderr.write("funnel-proxy: %s\n" % (err,))
        sys.stderr.flush()
    finally:
        client.close()
        if remote is not None:
            remote.close()


def main() -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((LISTEN_HOST, LISTEN_PORT))
    srv.listen(128)
    while True:
        client, _addr = srv.accept()
        threading.Thread(target=_handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
