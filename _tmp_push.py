import io

p = r'D:\dshdata\本地\dsh-session-orchestrator\lib\index.js'
s = io.open(p, encoding='utf-8').read()

# 两处「把你要的那个告诉我」——这是给人看的，但 agent 收不到。
# 改法：保留给人看的可操作提示（复制 id），同时用 prompt 把候选清单递给 agent，
# 让 agent 下一轮能主动追问。两件事分开做，不要混为一谈。
old1 = """              return fail(
                [
                  '没找到这个会话 id：' + parsed.sessionId,
                  '',
                  '正确格式（给多少算多少，至少要有一样）：',
                  '  /register-peer <会话id> [名字]',
                  '  /register-peer <工作区名> [名字]',
                  '    会话id 或 工作区名   至少给一样',
                  '    名字                 可选，不给就自动取「工作区名-会话尾号」',
                  scopeNote,
                  lines.length > 0 ? '' : null,
                  lines.length > 0 ? '现有的会话（只说名字或编号就行）：' : null,
                  lines.length > 0 ? lines.join('\\n') : '这台机器上没有可注册的会话。',
                  '',
                  '嫌麻烦的话，把下面这行复制给助手，它会自己走完：',
                  '',
                  '  用会话编排插件把另一个会话加进好友表。' +
                    '我不知道它的会话 id，帮我列出现有会话让我挑，选好再注册。',
                ]
                  .filter((line) => line !== null)
                  .join('\\n'),
              )"""

new1 = """              // 命令的 text 人类看得到、agent 看不到；候选清单要单独递给 agent。
              await pushToAgent(agentId, candidateBrief)
              return fail(
                [
                  '没找到这个会话 id：' + parsed.sessionId,
                  '',
                  '正确格式（给多少算多少，至少要有一样）：',
                  '  /register-peer <会话id> [名字]',
                  '  /register-peer <工作区名> [名字]',
                  '    会话id 或 工作区名   至少给一样',
                  '    名字                 可选，不给就自动取「工作区名-会话尾号」',
                  scopeNote,
                  lines.length > 0 ? '' : null,
                  lines.length > 0 ? '现有的会话（复制你要的那个 id 再接一次）：' : null,
                  lines.length > 0 ? lines.join('\\n') : '这台机器上没有可注册的会话。',
                  '',
                  '嫌麻烦的话，把下面这行复制给助手，它会自己走完：',
                  '',
                  '  用会话编排插件把另一个会话加进好友表。' +
                    '我不知道它的会话 id，帮我列出现有会话让我挑，选好再注册。',
                ]
                  .filter((line) => line !== null)
                  .join('\\n'),
              )"""

assert old1 in s, 'site1 anchor missing'
s = s.replace(old1, new1, 1)

old2 = """            return {
              kind: 'error',
              text:
                '匹配到 ' + candidates.length + ' 个会话：\\n' +
                lines.join('\\n') +
                '\\n\\n把你要的那个告诉我（说编号或名字都行），我再注册。',
            }"""
new2 = """            await pushToAgent(agentId, candidateBrief)
            return {
              kind: 'error',
              text:
                '匹配到 ' + candidates.length + ' 个会话：\\n' +
                lines.join('\\n') +
                '\\n\\n复制你要的那个 id，再接一次 /register-peer <id>。',
            }"""
assert old2 in s, 'site2 anchor missing'
s = s.replace(old2, new2, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('candidate brief now pushed to agent')
