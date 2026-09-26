#!/usr/bin/env python3
# Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
# Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
# GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

"""Builds and runs the lambda locally, the way the platform would host it.

    tools/local.py [--port 8080] [--no-run]

The server/ folder is the lambda: lambda.cs is the snippet, the other .cs
files hold types, server/web/ are the assets. This wraps them into the
standalone project the platform exports (tools/harness) under .local/.
"""
import argparse, os, re, shutil, subprocess, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
server = os.path.join(root, 'server')
harness = os.path.join(root, 'tools', 'harness')
out = os.path.join(root, '.local')

ap = argparse.ArgumentParser()
ap.add_argument('--port', default='8080')
ap.add_argument('--no-run', action='store_true')
args = ap.parse_args()

os.makedirs(out, exist_ok=True)
for f in ('harness.csproj', 'Folder.cs', 'GlobalUsings.cs'):
    shutil.copy(os.path.join(harness, f), out)
for f in os.listdir(out):
    if f.endswith('.cs') and f not in ('Folder.cs', 'GlobalUsings.cs', 'Program.cs'):
        os.remove(os.path.join(out, f))

snippet = open(os.path.join(server, 'lambda.cs')).read()
usings = [l for l in snippet.splitlines() if re.match(r'^using [\w.]+;\s*$', l)]
code = '\n'.join(l for l in snippet.splitlines() if l not in usings)
program = open(os.path.join(harness, 'Program.template')).read().replace('//LAMBDA//', code)
open(os.path.join(out, 'Program.cs'), 'w').write('\n'.join(usings) + '\n' + program)

for f in os.listdir(server):
    if f.endswith('.cs') and f != 'lambda.cs':
        src = open(os.path.join(server, f)).read()
        open(os.path.join(out, f), 'w').write(src)

assets = os.path.join(out, 'assets')
os.makedirs(assets, exist_ok=True)
link = os.path.join(assets, 'web')
if not os.path.islink(link):
    if os.path.exists(link):
        shutil.rmtree(link)
    os.symlink(os.path.join(server, 'web'), link)

ws = os.path.join(out, 'workspace')
os.makedirs(ws, exist_ok=True)
media = os.path.join(root, 'media')
if os.path.isdir(media):
    dst = os.path.join(ws, 'media')
    if not os.path.islink(dst):
        os.symlink(media, dst)

r = subprocess.run(['dotnet', 'build', '-nologo', '-v', 'q', '-clp:ErrorsOnly'], cwd=out)
if r.returncode != 0 or args.no_run:
    sys.exit(r.returncode)
env = dict(os.environ, PORT=args.port)
os.execvpe('dotnet', ['dotnet', 'run', '--no-build'], env) if False else None
os.chdir(out)
os.execvpe('dotnet', ['dotnet', os.path.join('bin', 'Debug', 'net10.0', 'harness.dll')], env)
