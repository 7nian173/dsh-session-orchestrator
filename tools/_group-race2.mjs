import { rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMailbox, ensureWorkspaceBox } from '../lib/mail.js'
const tmp = join(process.cwd(), '_tmp', 'group-race2')
await rm(tmp, { recursive: true, force: true })
await ensureWorkspaceBox(tmp)
const box = createMailbox({ ackTimeoutMs: 600000, service: () => undefined, log: () => {}, cwdOf: async () => tmp })
for (let i = 0; i < 20; i++) {
  await rm(join(tmp, '.dsh-mail', 'group.json'), { force: true })
  const a = await box.groupCreate({ memberA: 'D1', memberB: 'E1', cwd: tmp })
  const afterA = JSON.parse(await readFile(join(tmp, '.dsh-mail', 'group.json'), 'utf8'))
  const b = await box.groupCreate({ members: ['F1','G1','H1'], cwd: tmp })
  const afterB = JSON.parse(await readFile(join(tmp, '.dsh-mail', 'group.json'), 'utf8'))
  if (a.group.id === b.group.id) {
    console.log('COLLISION', i, 'a=', a.group.id, 'afterA=', afterA.groups.map(g=>g.id), 'b=', b.group.id, 'afterB=', afterB.groups.map(g=>g.id))
    break
  }
}
console.log('done')
