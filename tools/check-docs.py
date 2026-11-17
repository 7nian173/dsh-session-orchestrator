# -*- coding: utf-8 -*-
"""文档自检：中文排版（中英/中数缺空格、全角标点）与禁用文风。

用法：python3 tools/check-docs.py README.md
退出码：0 无问题，1 有问题。CI 直接拿退出码当闸门。
"""
import re, io, sys
path = sys.argv[1]
text = io.open(path, encoding='utf-8').read()
fails = []

# 1) 破折号
for m in re.finditer(r'[—–]|——', text):
    fails.append('破折号 at %d: %s' % (m.start(), text[max(0,m.start()-20):m.start()+20].replace('\n',' ')))

# 2) 翻案腔
for pat in [r'不是[^。\n]{1,30}而是', r'并非[^。\n]{1,30}而是', r'与其说', r'看似[^。\n]{1,20}实则', r'不在于[^。\n]{1,20}而在于', r'你以为']:
    for m in re.finditer(pat, text):
        fails.append('翻案腔 [%s] %s' % (pat, text[max(0,m.start()-10):m.end()+10].replace('\n',' ')))

# 3) 提示性冒号
for pat in [r'一句话总结[：:]', r'核心是[：:]', r'关键在于[：:]', r'原因如下[：:]', r'以下几点[：:]']:
    for m in re.finditer(pat, text):
        fails.append('提示性冒号: ' + text[m.start():m.end()+10])

# 4) 起手式
for pat in [r'说白了', r'说穿了', r'先说结论', r'众所周知']:
    for m in re.finditer(pat, text):
        fails.append('起手式: ' + pat)

# 5) 末段号召
for pat in [r'让我们', r'总而言之', r'综上所述']:
    for m in re.finditer(pat, text):
        fails.append('套话: ' + pat)

# 6) 中英文缺空格（跳过代码块）
lines = text.split('\n')
in_code = False
for i, line in enumerate(lines, 1):
    if line.strip().startswith('```'):
        in_code = not in_code
        continue
    if in_code: continue
    s = re.sub(r'`[^`]*`', '', line)
    s = re.sub(r'\[[^\]]*\]\([^)]*\)', '', s)
    for m in re.finditer(r'[\u4e00-\u9fa5][A-Za-z0-9]', s):
        fails.append('缺空格 L%d: %s' % (i, s[max(0,m.start()-8):m.end()+6]))
    for m in re.finditer(r'[A-Za-z0-9][\u4e00-\u9fa5]', s):
        fails.append('缺空格 L%d: %s' % (i, s[max(0,m.start()-8):m.end()+6]))

print('file:', path, '· lines:', len(lines))
print('issues:', len(fails))
for f in fails[:25]: print('  -', f)
sys.exit(1 if fails else 0)
