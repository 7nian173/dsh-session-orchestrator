import io

p = r'D:\dshdata\本地\dsh-session-orchestrator\lib\mail.js'
s = io.open(p, encoding='utf-8').read()

# ── 信使形态 B：去掉「N 分钟前」，改成绝对时刻 ──
old1 = """      '〔信使〕你名下现在 ' + mine.length + ' 封待办：' + parts + '，最早 ' + minutes + ' 分钟前。',"""
new1 = """      '〔信使〕你名下现在 ' + mine.length + ' 封待办：' + parts + '，最早一封发出于 ' + stampAbs(oldest) + '。',"""
assert old1 in s, 'courierB anchor missing'
s = s.replace(old1, new1, 1)

# ── 开工横幅：去掉「N 分钟前」 ──
old2 = """      '〔信箱·开工检查〕现在 ' + stampNow() + '（本机时区），你有 ' + mine.length + ' 封未读，最早 ' + minutes + ' 分钟前。' +"""
new2 = """      '〔信箱·开工检查〕你有 ' + mine.length + ' 封未读，最早一封 ' + stampAbs(oldest) + '。' +"""
assert old2 in s, 'banner anchor missing'
s = s.replace(old2, new2, 1)

# ── mail_inbox 每行：把「N 分钟前」换成发出时刻 ──
old3 = """        index + 1 + '. ' + row.mailId + ' · ' + row.type + (row.urgent ? ' · 加急' : '') + ' · 来自 ' + row.from + ' · ' + row.status + ' ' + row.dir + ' · ' + row.ageMinutes + ' 分钟前',"""
new3 = """        index + 1 + '. ' + row.mailId + ' · ' + row.type + (row.urgent ? ' · 加急' : '') + ' · 来自 ' + row.from + ' · ' + row.status + ' ' + row.dir + ' · ' + stampAbs(Date.parse(row.sentAt)),"""
assert old3 in s, 'inbox line anchor missing'
s = s.replace(old3, new3, 1)

# ── 新增 stampAbs：只给绝对时刻 ──
anchor = """  /**
   * 时间标注：**只报「本信几时发出」，不报「现在几点」。"""
assert anchor in s, 'stampOf doc anchor missing'

helper = """  /**
   * 绝对时刻：给信使/横幅/inbox 用。
   * 只报「什么时候」，不报「多久以前」——延迟投递时相对时间一定会说谎。
   */
  function stampAbs(value) {
    const d = value instanceof Date ? value : new Date(Number(value) || value)
    if (Number.isNaN(d.getTime())) return '时间未知'
    const hhmm = (x) => String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0')
    const off = -d.getTimezoneOffset()
    const sign = off >= 0 ? '+' : '-'
    const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0')
    const zone = 'UTC' + sign + pad(off / 60) + ':' + pad(off % 60)
    // 跨天时补日期，避免「昨天 23:50」被读成今天
    const today = new Date()
    const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
    return (sameDay ? '' : String(d.getMonth() + 1) + '/' + String(d.getDate()) + ' ') + hhmm(d) + '（' + zone + '）'
  }

""" + anchor

s = s.replace(anchor, helper, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('relative times removed')
