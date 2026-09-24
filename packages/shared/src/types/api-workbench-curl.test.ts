import { describe, expect, test } from 'bun:test'
import { createCurlCommand, parseCurlCommands } from './api-workbench-curl'

/** 断言解析结果只含一条草稿并直接返回，避免每处重复取首项。 */
function single(input: string) {
  const result = parseCurlCommands(input)
  expect(result.drafts).toHaveLength(1)
  return { draft: result.drafts[0]!, ...result }
}

describe('cURL 导入', () => {
  test('Given 浏览器复制的 POST JSON 命令 When 解析 Then 得到方法、地址、请求头与正文', () => {
    const result = parseCurlCommands(
      "curl 'https://api.example.com/users' -X POST -H 'Content-Type: application/json' -H 'X-Trace: abc' --data-raw '{\"name\":\"甲\"}'",
    )

    expect(result.drafts).toHaveLength(1)
    const draft = result.drafts[0]!
    expect(draft.method).toBe('POST')
    expect(draft.url).toBe('https://api.example.com/users')
    expect(draft.headers.map((header) => `${header.name}:${header.value}`)).toEqual([
      'Content-Type:application/json',
      'X-Trace:abc',
    ])
    expect(draft.body.kind).toBe('json')
    expect(draft.body.text).toBe('{"name":"甲"}')
    expect(draft.query).toEqual([])
    expect(result.unsupported).toEqual([])
  })

  test('Given 省略请求方法但有数据 When 解析 Then 方法推断为 POST 且正文按表单解析', () => {
    const { draft } = single("curl https://api.example.com/login -d 'user=ada&scope=read'")

    expect(draft.method).toBe('POST')
    expect(draft.body.kind).toBe('urlencoded')
    expect(draft.body.fields.map((field) => `${field.name}=${field.value}`)).toEqual(['user=ada', 'scope=read'])
    expect(draft.body.text).toBe('')
  })

  test('Given -G 形式 When 解析 Then 数据进入查询参数并解码且方法保持 GET', () => {
    const { draft } = single("curl -G https://api.example.com/search -d 'q=%E7%94%B2' -d 'page=2'")

    expect(draft.method).toBe('GET')
    expect(draft.body.kind).toBe('none')
    expect(draft.query.map((field) => `${field.name}=${field.value}`)).toEqual(['q=甲', 'page=2'])
  })

  test('Given 行连续符与引号混用 When 解析 Then 只在引号外分词并保留引号内空格', () => {
    const input = 'curl -X POST \\\n  --url "https://api.example.com/a b" \\\n  -H "X-Note: 甲 \'乙\' 丙" \\\n  -d "x=$HOME"'
    const { draft } = single(input)

    expect(draft.url).toBe('https://api.example.com/a b')
    expect(draft.headers[0]?.value).toBe("甲 '乙' 丙")
    expect(draft.body.fields[0]?.value).toBe('$HOME')
  })

  test('Given BASIC 鉴权参数 When 解析 Then 生成 Basic 鉴权并把密码标记为秘密', () => {
    const { draft } = single('curl -u ada:secret https://api.example.com/me')

    expect(draft.auth.type).toBe('basic')
    expect(draft.auth.username).toBe('ada')
    expect(draft.auth.value.value).toBe('secret')
    expect(draft.auth.value.secret).toBe(true)
    expect(draft.url).toBe('https://api.example.com/me')
  })

  test('Given --json 简写 When 解析 Then 正文类型为 JSON', () => {
    const { draft } = single("curl --json '{\"a\":1}' https://api.example.com/j")

    expect(draft.body.kind).toBe('json')
    expect(draft.body.text).toBe('{"a":1}')
  })

  test('Given 重定向与超时参数 When 解析 Then 映射为跟随重定向与毫秒超时', () => {
    const { draft } = single('curl -L --max-time 12 https://api.example.com/r')

    expect(draft.followRedirects).toBe(true)
    expect(draft.timeoutMs).toBe(12_000)
  })

  test('Given 保留无关输出参数 When 解析 Then 逐条说明未支持且仍导入请求本身', () => {
    const result = single("curl -k -o out.json -X POST https://api.example.com/u -H 'X-A: 1'")

    expect(result.draft.method).toBe('POST')
    expect(result.draft.headers[0]?.value).toBe('1')
    expect(result.unsupported.join(' ')).toContain('-k')
    expect(result.unsupported.join(' ')).toContain('-o')
    expect(result.unsupported.join(' ')).toContain('证书校验')
  })

  test('Given 命令替换与反引号 When 解析 Then 不执行子命令且报告未执行', () => {
    const input = 'curl "https://api.example.com/$(whoami)" -H "X-B: `id`"'
    const { draft, unsupported } = single(input)

    expect(draft.url).toBe('https://api.example.com/$(whoami)')
    expect(draft.headers[0]?.value).toBe('`id`')
    expect(unsupported.join(' ')).toContain('命令替换')
  })

  test('Given 多条命令 When 解析 Then 每条生成独立草稿', () => {
    const result = parseCurlCommands('curl https://a.example.com/1\ncurl -X DELETE https://b.example.com/2')

    expect(result.drafts.map((draft) => draft.method)).toEqual(['GET', 'DELETE'])
    expect(result.drafts.map((draft) => draft.url)).toEqual(['https://a.example.com/1', 'https://b.example.com/2'])
  })

  test('Given 多段数据 When 解析 Then 按 curl 规则用 & 拼接同一正文', () => {
    /** curl 会把同一命令里的多段数据用 & 合并，导入必须保持这一事实。 */
    const json = single(`curl -X POST https://api.example.com/m --data-raw '{"a":' --data-raw '1}' -H 'Content-Type: application/json'`).draft
    const text = single(`curl -X POST https://api.example.com/t -H 'Content-Type: text/plain' -d 'line1' -d 'line2'`).draft

    expect(json.body.kind).toBe('json')
    expect(json.body.text).toBe('{"a":&1}')
    expect(text.body.kind).toBe('text')
    expect(text.body.text).toBe('line1&line2')
  })

  test('Given Cookie 字面量 When 解析 Then 变成秘密 Cookie 请求头', () => {
    const { draft } = single("curl -b 'sid=abc' https://api.example.com/c")

    expect(draft.headers[0]?.name).toBe('Cookie')
    expect(draft.headers[0]?.value).toBe('sid=abc')
    expect(draft.headers[0]?.secret).toBe(true)
  })

  test('Given 空值请求头 When 解析 Then 保留空值而不丢弃该行', () => {
    const { draft } = single("curl -H 'X-Empty;' https://api.example.com/e")

    expect(draft.headers.map((header) => `${header.name}=${header.value}`)).toEqual(['X-Empty='])
  })

  test('Given 正文来自本机文件 When 解析 Then 拒绝该命令并说明未读取文件', () => {
    const result = parseCurlCommands('curl -d @payload.json https://api.example.com/p')

    expect(result.drafts).toEqual([])
    expect(result.unsupported.join(' ')).toContain('@payload.json')
    expect(result.unsupported.join(' ')).toContain('未读取')
  })

  test('Given JSON 简写指向本机文件 When 解析 Then 拒绝该命令而不把路径当成正文', () => {
    const result = parseCurlCommands('curl --json @payload.json https://api.example.com/j')

    expect(result.drafts).toEqual([])
    expect(result.unsupported.join(' ')).toContain('@payload.json')
    expect(result.unsupported.join(' ')).toContain('未读取')
  })

  test('Given multipart 或上传文件 When 解析 Then 拒绝该命令而不丢弃正文静默发送', () => {
    expect(parseCurlCommands("curl -F 'file=@a.png' https://api.example.com/u").drafts).toEqual([])
    expect(parseCurlCommands('curl -T b.txt https://api.example.com/u').drafts).toEqual([])
  })

  test('Given Cookie 文件引用 When 解析 Then 拒绝并说明不读取本机文件', () => {
    const result = parseCurlCommands('curl -b cookies.txt https://api.example.com/c')

    expect(result.drafts).toEqual([])
    expect(result.unsupported.join(' ')).toContain('cookies.txt')
  })

  test('Given 空输入或没有 curl 命令 When 解析 Then 明确报错而不是返回空结果', () => {
    expect(() => parseCurlCommands('   \n  ')).toThrow('API_CURL_INVALID')
    expect(() => parseCurlCommands('这是一段说明文字，不是命令')).toThrow('API_CURL_INVALID')
  })

  test('Given 地址不是 HTTP When 解析 Then 拒绝该命令并说明原因', () => {
    const result = parseCurlCommands('curl file:///etc/passwd')

    expect(result.drafts).toEqual([])
    expect(result.unsupported.join(' ')).toContain('http')
  })

  test('Given 命令条数超过上限 When 解析 Then 拒绝整段输入', () => {
    const tooMany = Array.from({ length: 40 }, (_, index) => `curl https://a.example.com/${index}`).join('\n')

    expect(() => parseCurlCommands(tooMany)).toThrow('API_CURL_INVALID')
    expect(parseCurlCommands(Array.from({ length: 32 }, (_, index) => `curl https://a.example.com/${index}`).join('\n')).drafts).toHaveLength(32)
  })

  test('Given 非 curl 行混在命令之间 When 解析 Then 忽略并说明忽略了几行', () => {
    const result = parseCurlCommands('示例：\ncurl https://a.example.com/1\n说明文字')

    expect(result.drafts).toHaveLength(1)
    expect(result.warnings.join(' ')).toContain('忽略')
  })
})

describe('cURL 导出', () => {
  test('Given 草稿含秘密与查询行 When 生成命令 Then 秘密替换为占位符并列出替换位置', () => {
    const result = createCurlCommand({
      name: '创建用户',
      collectionId: 'default',
      folder: '',
      description: '',
      method: 'POST',
      url: 'https://api.example.com/users',
      query: [{ id: 'q1', name: 'dry', value: '1', enabled: true }],
      headers: [{ id: 'h1', name: 'Authorization', value: 'Bearer abc', enabled: true, secret: true }],
      body: { kind: 'json', text: '{"name":"甲"}', fields: [] },
      auth: { type: 'none', value: { value: '' } },
      timeoutMs: 30_000,
      followRedirects: false,
      maxRedirects: 5,
      assertions: [],
    })

    expect(result.command.startsWith('curl ')).toBe(true)
    expect(result.command).toContain('--request POST')
    expect(result.command).toContain('https://api.example.com/users?dry=1')
    expect(result.command).toContain('{{')
    expect(result.command).not.toContain('Bearer abc')
    expect(result.redactedSecrets).toEqual(['Authorization'])
  })

  test('Given 生成的命令再次解析 When 往返 Then 方法与请求头保持一致', () => {
    const source = single("curl -X PUT 'https://api.example.com/items?page=2' -H 'X-A: 1' -H 'Content-Type: application/json' --data-raw '{\"n\":1}'").draft
    const generated = createCurlCommand({ ...source, headers: source.headers.filter((header) => header.value !== '') })
    const { draft } = single(generated.command)

    expect(draft.method).toBe('PUT')
    expect(draft.url).toBe('https://api.example.com/items?page=2')
    expect(draft.headers.map((header) => `${header.name}:${header.value}`)).toEqual(['X-A:1', 'Content-Type:application/json'])
    expect(draft.body.text).toBe('{"n":1}')
    expect(generated.redactedSecrets).toEqual([])
  })

  test('Given Bearer 与 Basic 鉴权为秘密 When 生成命令 Then 凭据只以占位符出现', () => {
    const base = single('curl https://api.example.com/x').draft
    const bearer = createCurlCommand({ ...base, auth: { type: 'bearer', value: { value: 'tok_live_123', secret: true } } })
    const basic = createCurlCommand({ ...base, auth: { type: 'basic', username: 'ada', value: { value: 'pw_123', secret: true } } })

    expect(bearer.command).not.toContain('tok_live_123')
    expect(bearer.command).toContain('{{')
    expect(bearer.redactedSecrets).toEqual(['Authorization'])
    expect(basic.command).not.toContain('pw_123')
    expect(basic.command).toContain('--user')
    expect(basic.redactedSecrets).toEqual(['Password'])
  })
})
