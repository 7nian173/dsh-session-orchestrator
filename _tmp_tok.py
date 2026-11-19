import io

p = r'D:\dshdata\本地\dsh-session-orchestrator\lib\index.js'
s = io.open(p, encoding='utf-8').read()

B = chr(92)
BS = B + B  # 在源码里表示一个反斜杠字面量需要两个

old = (
    "    const workspaceToken = (cwd) => {\n"
    "      const path = String(cwd || '').replace(/[" + BS + BS + "/]+$/, '')\n"
    "      const seg = path.split(/[" + BS + BS + "/]/).pop() || 'workspace'\n"
    "      return seg.replace(/[^" + B + "w" + B + "u4e00-" + B + "u9fa5-]/g, '').slice(0, 24) || 'workspace'\n"
    "    }"
)

new = (
    "    /**\n"
    "     * 工作区短名：取路径末段；冲突时补父目录首字母与短哈希。\n"
    "     * 例：E:" + BS + "AI Projects" + BS + "Super-agent → Super-agent\n"
    "     *     重名时 → Super-agent-AI-a3f2\n"
    "     */\n"
    "    const workspaceToken = (cwd, { disambiguate = false } = {}) => {\n"
    "      const raw = String(cwd || '').replace(/[" + BS + BS + "/]+$/, '')\n"
    "      const parts = raw.split(/[" + BS + BS + "/]+/).filter(Boolean)\n"
    "      const seg = parts[parts.length - 1] || 'workspace'\n"
    "      const clean = seg.replace(/[^" + B + "w" + B + "u4e00-" + B + "u9fa5-]/g, '').slice(0, 32) || 'workspace'\n"
    "      if (!disambiguate) return clean\n"
    "      const parent = parts.length >= 3\n"
    "        ? String(parts[parts.length - 2]).replace(/[^" + B + "w" + B + "u4e00-" + B + "u9fa5]/g, '').slice(0, 4)\n"
    "        : ''\n"
    "      let hash = 0\n"
    "      for (const ch of raw.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) % 0xffff\n"
    "      const suffix = hash.toString(16).padStart(4, '0').slice(0, 4)\n"
    "      return [clean, parent, suffix].filter(Boolean).join('-').slice(0, 32)\n"
    "    }\n"
    "\n"
    "    /** 已有好友里是否已占用这个名字。 */\n"
    "    const nameTaken = async (name) => {\n"
    "      const table = await loadFriends().catch(() => ({}))\n"
    "      return Object.prototype.hasOwnProperty.call(table || {}, name)\n"
    "    }"
)

assert old in s, 'workspaceToken anchor missing'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('workspaceToken upgraded')
