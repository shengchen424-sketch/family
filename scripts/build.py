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
html = html.replace('<script src="logic.js"></script>', '<script>\n' + logic + '\n</script>', 1)
main = html.index('<script>\n(function () {')
html = html[:main] + shim + '\n' + api + '\n' + html[main:]
# app.html is a body fragment (the Apps Script host adds the document shell); the VPS serves it as a full page
head = ('<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '<meta name="theme-color" content="#2d6a4f">\n<meta name="apple-mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-status-bar-style" content="default">\n<meta name="apple-mobile-web-app-title" content="家庭资产">\n'
        '<link rel="manifest" href="/manifest.webmanifest">\n<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">\n<link rel="icon" href="/icons/icon-192.png">\n')
html = head + html
os.makedirs(os.path.join(root, 'public'), exist_ok=True)
open(os.path.join(root, 'public/index.html'), 'w', encoding='utf-8').write(html)
print('built public/index.html', len(html), 'chars')
