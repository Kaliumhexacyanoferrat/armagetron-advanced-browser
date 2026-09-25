#!/usr/bin/env python3
"""Converts the original cycle models (models/*.mod) into web/js/models.js.

Follows rModel::Load's old loader: texture coordinates are the x/z extent
of the model, normals are averaged face normals (smooth shading).
"""
import json, math, os, sys

src = sys.argv[1] if len(sys.argv) > 1 else '../armagetronad/models'
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load(path):
    verts, faces = {}, []
    for line in open(path):
        p = line.split()
        if not p: continue
        if p[0] == 'v': verts[int(p[1])] = tuple(map(float, p[2:5]))
        elif p[0] == 'f': faces.append(tuple(map(int, p[1:4])))
    xs = [v[0] for v in verts.values()]; zs = [v[2] for v in verts.values()]
    xmin, xmax, zmin, zmax = min(xs), max(xs), min(zs), max(zs)
    normals = {i: [0.0, 0.0, 0.0] for i in verts}
    for a, b, c in faces:
        A, B, C = verts[a], verts[b], verts[c]
        X = [B[i] - A[i] for i in range(3)]; Y = [C[i] - A[i] for i in range(3)]
        n = [X[1]*Y[2]-X[2]*Y[1], X[2]*Y[0]-X[0]*Y[2], X[0]*Y[1]-X[1]*Y[0]]
        l = math.sqrt(sum(x*x for x in n)) or 1
        for i in (a, b, c):
            for k in range(3): normals[i][k] += n[k] / l
    ids = sorted(verts)
    index = {v: i for i, v in enumerate(ids)}
    data = []
    for i in ids:
        v = verts[i]; n = normals[i]; l = math.sqrt(sum(x*x for x in n)) or 1
        u = (v[0]-xmin)/(xmax-xmin); t = (zmax-v[2])/(zmax-zmin)
        data += [round(x, 5) for x in (*v, n[0]/l, n[1]/l, n[2]/l, u, t)]
    return {'v': data, 'i': [index[x] for f in faces for x in f]}

models = {n: load(os.path.join(src, f'cycle_{n}.mod')) for n in ('body', 'front', 'rear')}
with open(os.path.join(root, 'server', 'web', 'js', 'models.js'), 'w') as f:
    f.write('// The original light cycle models (models/cycle_*.mod), converted by tools/models.py.\n')
    f.write('// Per vertex: position xyz, normal xyz, texture uv. Triangles in i.\n')
    f.write('export const MODELS = ' + json.dumps(models, separators=(',', ':')) + ';\n')
print('ok')
