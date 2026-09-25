#!/usr/bin/env python3
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
