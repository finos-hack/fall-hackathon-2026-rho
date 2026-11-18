"""Stateless local CALM Hub lens backend. No data is retained."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs, unquote
import json
import os
import re
from ripples import lens

MAX_BODY = 4 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Avoid logging architecture data or request parameters.

    def do_POST(self):
        url = urlsplit(self.path)
        match = re.fullmatch(r'/lens/([^/]+)/architectures/([^/]+)', url.path)
        if not match:
            return self.reply(404, {'error': 'not found'})
        try:
            length = int(self.headers.get('Content-Length', '-1'))
            if length < 0 or length > MAX_BODY:
                return self.reply(413, {'error': 'invalid request size'})
            body = json.loads(self.rfile.read(length))
            document = body.get('document') if isinstance(body, dict) else None
            if not isinstance(document, dict):
                raise ValueError('CALM Hub must send an architecture document')
            origin = parse_qs(url.query).get('origin', [None])[0]
            view = parse_qs(url.query).get('view', ['ripple'])[0]
            depth = parse_qs(url.query).get('depth', ['2'])[0]
            self.reply(200, lens(document, origin, view, depth))
        except (ValueError, TypeError, AttributeError, KeyError) as error:
            self.reply(400, {'type': 'about:blank', 'title': 'Cannot analyze this architecture', 'status': 400, 'detail': str(error)}, 'application/problem+json')

    def do_GET(self):
        if self.path == '/healthz':
            return self.reply(200, {'status': 'ok'})
        self.reply(404, {'error': 'not found'})

    def reply(self, status, body, content_type='application/json'):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    ThreadingHTTPServer((os.environ.get('HOST', '127.0.0.1'), int(os.environ.get('PORT', '8095'))), Handler).serve_forever()
