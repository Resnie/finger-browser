#!/usr/bin/env python3
"""通过隐藏输入将发布令牌存入 macOS 钥匙串；不写入源码、终端历史或输出。"""
import getpass
import re
import subprocess
import sys

if sys.platform != 'darwin':
    raise SystemExit('请在当前 Mac 的终端中执行此工具。')
token = getpass.getpass('粘贴 GitHub 发布令牌（输入不显示）: ').strip()
if not re.fullmatch(r'github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+', token):
    raise SystemExit('令牌格式不正确，未保存。')
result = subprocess.run(['security', 'add-generic-password', '-U', '-a', getpass.getuser(),
                         '-s', 'finger-browser-github-release', '-w', token],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
if result.returncode:
    raise SystemExit('钥匙串保存失败，未输出令牌。')
print('发布令牌已保存到 macOS 钥匙串。')
