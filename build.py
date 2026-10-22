#!/usr/bin/env python3
"""Bundle src/*.js (ES modules) into js/bazinga.js (one classic script).

A single classic script works everywhere: hosted on GitHub Pages AND when
index.html is opened straight from disk (browsers block ES modules on file://).
Run:  python3 build.py   after editing anything in src/.
"""
import re, pathlib

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / 'src'
ORDER = ['db', 'util', 'ui', 'meta', 'store', 'youtube', 'spotify', 'importers', 'player', 'backup', 'legal', 'app']

def convert(name, code):
    exports = re.findall(r'^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)', code, re.M)
    def imp(m):
        what, mod = m.group(1).strip(), m.group(2)
        ref = '__m_' + mod
        if what.startswith('*'):
            return f'const {what.split(" as ")[1].strip()} = {ref};'
        names = [n.strip() for n in what.strip('{} ').split(',') if n.strip()]
        names = [n.replace(' as ', ': ') for n in names]
        return 'const { ' + ', '.join(names) + ' } = ' + ref + ';'
    code = re.sub(r'^import\s+(.+?)\s+from\s+[\'"]\./(\w+)\.js[\'"];?', imp, code, flags=re.M | re.S)
    code = re.sub(r'^export\s+', '', code, flags=re.M)
    return f'const __m_{name} = (() => {{\n{code}\nreturn {{ {", ".join(exports)} }};\n}})();\n'

out = ['/* BAZINGA — built from src/ by build.py. Edit src/, then run: python3 build.py */\n(() => {\n"use strict";\n']
for n in ORDER:
    out.append(f'// ---------- {n}.js ----------\n' + convert(n, (SRC / f'{n}.js').read_text()))
out.append('})();\n')
(ROOT / 'js').mkdir(exist_ok=True)
(ROOT / 'js' / 'bazinga.js').write_text(''.join(out))
print('built js/bazinga.js')
