#!/usr/bin/env python3
"""Builds public/index.html (the page the VPS serves) from src/.
Inlines logic.js, then inserts the Apps Script shim (talks to server.js), the data layer and the seed data
right before the main app script, and prepends the document head (charset, viewport)."""
import os
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rd = lambda p: open(os.path.join(root, p), encoding='utf-8').read()
html = rd('src/app.html')
logic = rd('src/logic.js')
api = rd('src/api.html')
shim = rd('src/shim.html')
assert '<script src="logic.js"></script>' in html, 'logic include missing'
seed = rd('tests/seed.js')
html = html.replace('<script src="logic.js"></script>', '<script>\n' + logic + '\n</script>', 1)
main = html.index('<script>\n(function () {')
html = html[:main] + shim + '\n' + api + '\n<script>\n' + seed + '\n</script>\n' + html[main:]
# app.html is a body fragment (the Apps Script host adds the document shell); the VPS serves it as a full page
head = ('<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n')
html = head + html
os.makedirs(os.path.join(root, 'public'), exist_ok=True)
open(os.path.join(root, 'public/index.html'), 'w', encoding='utf-8').write(html)
print('built public/index.html', len(html), 'chars')
