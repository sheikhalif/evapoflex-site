"""Static server for the Print Prep demo, with caching turned off.

The demo loads the tool as unbundled ES modules straight off disk. Plain
`python -m http.server` sends no cache headers, so the browser applies its
heuristic: a file whose Last-Modified is hours old is treated as fresh for
hours and never revalidated. Editing a module that had not been touched today
therefore changed nothing on reload - the browser kept serving the old one, and
the fix looked like it had failed.
"""
import http.server
import socketserver
import sys
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8124
ROOT = Path(__file__).resolve().parent.parent


class NoCache(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def send_header(self, key, value):
        # Drop the validator entirely; with no Last-Modified there is nothing
        # for the browser to revalidate against.
        if key.lower() == 'last-modified':
            return
        super().send_header(key, value)

    def log_message(self, fmt, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(('127.0.0.1', PORT), NoCache) as httpd:
    print(f'no-cache server on http://localhost:{PORT}/ serving {ROOT}')
    httpd.serve_forever()
