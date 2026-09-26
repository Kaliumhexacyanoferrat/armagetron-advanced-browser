#!/usr/bin/env python3
# Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
# Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
# GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

"""Compiles server/*.cs on the platform without saving: tools/check.py"""
import json, os, urllib.request
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
key = os.environ.get('GENHTTP_KEY') or open(os.path.join(root, '..', '.genhttp-key')).read().strip()
server = os.path.join(root, 'server')
names = ['lambda.cs'] + sorted(f for f in os.listdir(server) if f.endswith('.cs') and f != 'lambda.cs')
files = [{'Name': n, 'Code': open(os.path.join(server, n)).read()} for n in names]
req = urllib.request.Request(f'https://genhttp.dev/api/v1/lambdas/{key}/code/check', data=json.dumps({'Files': files}).encode(),
                             method='POST', headers={'Content-Type': 'application/json'})
try:
    res = urllib.request.urlopen(req).read().decode()
except urllib.error.HTTPError as e:
    res = e.read().decode()
print(res[:4000])
