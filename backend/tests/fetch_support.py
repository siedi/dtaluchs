"""A local server that plays the control; shared by `61_fetch_test.py` and `62_import_fetch_test.py`."""

import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


@dataclass
class Reply:
    status: int = 200
    body: bytes = b""
    headers: tuple[tuple[str, str], ...] = ()
    hang: bool = False
    announce: int | None = None  # Content-Length larger than the body, then the connection closes
    drip_s: float | None = None  # one byte of the body every drip_s seconds, announced in full
    unannounced: bool = False  # no Content-Length, the body ends when the connection closes


class Control:
    """A local server that answers per path; the test sets the answers."""

    def __init__(self) -> None:
        self.replies: dict[str, Reply] = {}
        self.requests: list[str] = []
        self.release = threading.Event()
        control = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # name fixed by http.server
                control.requests.append(self.path)
                reply = control.replies.get(self.path, Reply(404, b"<html>404</html>"))
                if reply.hang:
                    control.release.wait(10)
                    return
                self.send_response(reply.status)
                for key, value in reply.headers:
                    self.send_header(key, value)
                length = reply.announce if reply.announce is not None else len(reply.body)
                if not reply.unannounced:
                    self.send_header("Content-Length", str(length))
                self.end_headers()
                if reply.drip_s is not None:
                    for i in range(len(reply.body)):
                        self.wfile.write(reply.body[i : i + 1])
                        self.wfile.flush()
                        if control.release.wait(reply.drip_s):
                            return
                    return
                self.wfile.write(reply.body)
                if reply.announce is not None:
                    self.wfile.flush()
                    self.close_connection = True

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.address = f"127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self.thread.start()

    def close(self) -> None:
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
