#!/usr/bin/env python3
# Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
# Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
# GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

"""Pushes server/ as a new version of the lambda and deploys it.

    tools/deploy.py "what this version changes" [--media]

The editor key is read from $GENHTTP_KEY or ../.genhttp-key (never commit it).
--media also uploads media/ (the music) into the lambda's workspace.
"""
import io, json, os, sys, urllib.parse, urllib.request, zipfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
api = 'https://genhttp.dev/api/v1'
key = os.environ.get('GENHTTP_KEY') or open(os.path.join(root, '..', '.genhttp-key')).read().strip()

SPEC = open(os.path.join(root, 'tools', 'specification.txt')).read().strip()

def request(method, path, data=None, ctype='application/octet-stream'):
    req = urllib.request.Request(api + path, data=data, method=method, headers={'Content-Type': ctype})
    with urllib.request.urlopen(req) as res:
        return res.read()

args = [a for a in sys.argv[1:] if not a.startswith('--')]
change = args[0] if args else 'Update'

buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    server = os.path.join(root, 'server')
    for base, _, files in os.walk(server):
        for f in files:
            p = os.path.join(base, f)
            z.write(p, os.path.relpath(p, server))
print('zip', len(buf.getvalue()), 'bytes')

q = urllib.parse.urlencode({'deploy': 'true', 'change': change[:500], 'specification': SPEC[:4000]})
res = json.loads(request('POST', f'/lambdas/{key}/versions/zip?{q}', buf.getvalue(), 'application/zip'))
dep = res.get('deployment', {})
print('version', res.get('version'), 'deployed:', dep.get('success'))
for d in dep.get('diagnostics') or []:
    print(' ', d)

if '--media' in sys.argv:
    # files go up base64 encoded in JSON, at most 1 MB each; the server looks
    # for them when it starts, so deploy once more after the first upload
    import base64
    request('PUT', f'/lambdas/{key}/folders/media')
    media = os.path.join(root, 'media')
    for f in sorted(os.listdir(media)):
        data = open(os.path.join(media, f), 'rb').read()
        body = json.dumps({'Content': base64.b64encode(data).decode()}).encode()
        request('PUT', f'/lambdas/{key}/files/media%2F{f}', body, 'application/json')
        print('uploaded media/' + f, len(data))
