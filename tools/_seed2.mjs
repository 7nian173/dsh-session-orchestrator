const SEEDS = [
  // 「建/开/新建/创建/起」+ 任意量词/修饰 + 「工作区/项目/工作空间」
  { id: 'init-workspace', test: /(建|开|新建|创建|起)\s*[立]?\s*[一二几]?\s*(个|一个)?\s*新?\s*的?\s*(工作区|工作空间|项目|workspace)/i },
  // 注册/登记/添加，后面必须跟「好友/名字/名」或人称，或「注册成/注册为」
  { id: 'register-friend', test: /(注册|登记|添加|加)\s*(个|一个)?\s*(好友|名字|名(?![字])|它|他|她|你(?!好))|(注册|登记)\s*(成|为|到)/ },
  { id: 'send-letter', test: /(发|寄|送)\s*(个|一条|一封|一封)?\s*(信|信息|消息)|通知\s*(一下|他|她|它)/ },
  { id: 'any-session', test: /(跳|切|换|打开|去)\s*(到)?\s*(\S{0,10})\s*(会话|对话|窗口)/ },
]

const should = [
  ['帮我建立个工作区', 'init-workspace'],
  ['开个新项目的工作区', 'init-workspace'],
  ['我想新建一个工作区', 'init-workspace'],
  ['帮我开个工作区', 'init-workspace'],
  ['帮我注册个', 'register-friend'],
  ['把你注册个', 'register-friend'],
  ['给他注册个名字', 'register-friend'],
  ['注册成 ffw-dispatcher', 'register-friend'],
  ['帮我登记一下名字', 'register-friend'],
  ['给决策发个信息', 'send-letter'],
  ['通知一下对方', 'send-letter'],
  ['跳到那个会话去', 'any-session'],
  ['打开 FatFish 会话', 'any-session'],
]

const shouldNot = [
  '加到列表里',
  '这个函数要加个参数',
  '今天天气不错',
  '你好',
  '这个功能加个开关',
]

let fail = 0
for (const [text, want] of should) {
  const hit = SEEDS.find((s) => s.test.test(text))
  const got = hit ? hit.id : '(none)'
  const ok = got === want
  if (!ok) fail++
  console.log((ok ? '✅' : '❌') + ' ' + got.padEnd(16) + ' ' + text + (ok ? '' : '   期望 ' + want))
}
console.log('--- 不该触发 ---')
for (const text of shouldNot) {
  const hit = SEEDS.find((s) => s.test.test(text))
  const ok = !hit
  if (!ok) fail++
  console.log((ok ? '✅' : '❌') + ' ' + (hit ? hit.id : '(不触发)').padEnd(16) + ' ' + text)
}
console.log(fail === 0 ? '\n全部通过' : '\n失败 ' + fail + ' 条')
