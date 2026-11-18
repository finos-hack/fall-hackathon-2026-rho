"""Add the fictional architecture to the local demonstration Hub."""
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

base = os.environ.get('RIPPLES_HUB_URL', 'http://localhost:8091').rstrip('/') + '/api/calm/namespaces/demo/architectures'
for attempt in range(60):
    try:
        with urllib.request.urlopen(base, timeout=2) as response:
            existing = json.load(response).get('values', [])
        break
    except (OSError, ValueError):
        time.sleep(2)
else:
    raise SystemExit('Hub did not start; run docker-compose -f compose.yml logs hub')
name = 'Digital Bank — CALM Ripples'
match = next((row for row in existing if row.get('name') == name), None)
if match:
    print('Fictional digital bank already present.')
else:
    architecture = (Path(__file__).resolve().parents[1] / 'examples/digital-bank.calm.json').read_text()
    payload = json.dumps({'name': name, 'description': 'Fictional 42-system incident impact demo', 'architectureJson': architecture}).encode()
    request = urllib.request.Request(base, data=payload, headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=10) as response:
        print('Created fictional digital bank:', response.headers.get('Location', ''))
