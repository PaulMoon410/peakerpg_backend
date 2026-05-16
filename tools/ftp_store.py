#!/usr/bin/env python3
"""Minimal FTP helper for Peake RPG backend.

Usage:
  python3 ftp_store.py read /remote/path/file.json
  python3 ftp_store.py write /remote/path/file.json

Environment:
  PEAKE_FTP_HOST
  PEAKE_FTP_USER
  PEAKE_FTP_PASS
  PEAKE_FTP_PORT (optional, default 21)
  PEAKE_FTP_ROOT (optional, default /)
"""

from __future__ import annotations

import ftplib
import io
import json
import os
import posixpath
import sys
from pathlib import PurePosixPath


def emit(payload: dict, exit_code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    raise SystemExit(exit_code)


def get_env(name: str, default: str = "") -> str:
    value = os.getenv(name, default)
    if not value:
        emit({"ok": False, "error": f"Missing required env var: {name}"}, 1)
    return value


def ftp_connect() -> tuple[ftplib.FTP, str]:
    host = get_env("PEAKE_FTP_HOST")
    user = get_env("PEAKE_FTP_USER")
    password = get_env("PEAKE_FTP_PASS")
    port = int(os.getenv("PEAKE_FTP_PORT", "21"))
    root = os.getenv("PEAKE_FTP_ROOT", "/").strip() or "/"

    ftp = ftplib.FTP()
    ftp.connect(host, port, timeout=30)
    ftp.login(user, password)
    if root not in {"", "/"}:
        ftp.cwd(root)
    return ftp, root


def ensure_remote_dirs(ftp: ftplib.FTP, remote_path: str) -> None:
    path = PurePosixPath(remote_path)
    parts = path.parts[:-1]
    current = ""
    for part in parts:
        if part in {"/", ""}:
            continue
        current = posixpath.join(current, part) if current else part
        try:
            ftp.mkd(current)
        except ftplib.error_perm:
            pass


def read_remote(ftp: ftplib.FTP, remote_path: str) -> None:
    buffer = io.BytesIO()
    try:
        ftp.retrbinary(f"RETR {remote_path}", buffer.write)
    except ftplib.error_perm as error:
        emit({"ok": False, "error": str(error), "notFound": True}, 0)
        return
    content = buffer.getvalue().decode("utf-8")
    emit({"ok": True, "content": content})


def write_remote(ftp: ftplib.FTP, remote_path: str) -> None:
    content = sys.stdin.read()
    ensure_remote_dirs(ftp, remote_path)
    data = content.encode("utf-8")
    ftp.storbinary(f"STOR {remote_path}", io.BytesIO(data))
    emit({"ok": True, "bytes": len(data)})


def main() -> None:
    if len(sys.argv) < 3:
        emit({"ok": False, "error": "Usage: ftp_store.py <read|write> <remote_path>"}, 1)

    action = sys.argv[1]
    remote_path = sys.argv[2].lstrip("/")
    if not remote_path:
        emit({"ok": False, "error": "remote_path is required"}, 1)

    ftp, _root = ftp_connect()
    try:
        if action == "read":
            read_remote(ftp, remote_path)
        elif action == "write":
            write_remote(ftp, remote_path)
        else:
            emit({"ok": False, "error": f"Unknown action: {action}"}, 1)
    finally:
        try:
            ftp.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
