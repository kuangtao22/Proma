import { lookup as lookupDns } from 'node:dns/promises'
import { request as requestHttps } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { MAX_ATTACHMENT_SIZE } from '@proma/shared'

/** DNS 返回并由请求层固定使用的 IP 地址。 */
export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

/** 安全下载循环使用的最小 HTTP 响应。 */
export interface RemoteImageResponse {
  statusCode: number
  headers: Record<string, string | undefined>
  body: AsyncIterable<Uint8Array>
  /** 允许生产 transport 立即释放未消费或异常响应。 */
  cancel?: () => void
}

/** 可注入的 DNS 与 HTTPS transport，测试不访问真实网络。 */
export interface SafeRemoteImageDependencies {
  lookup: (hostname: string) => Promise<ResolvedAddress[]>
  request: (input: {
    url: URL
    address: string
    family: 4 | 6
    signal?: AbortSignal
  }) => Promise<RemoteImageResponse>
  maxBytes?: number
  maxRedirects?: number
}

/** 下载完成后允许进入附件保存流程的图片。 */
export interface DownloadedRemoteImage {
  bytes: Buffer
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

const DEFAULT_MAX_REDIRECTS = 3
const SUPPORTED_REMOTE_IMAGE_TYPES = new Set<DownloadedRemoteImage['mediaType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308])

/** 拒绝所有非公网 IPv4/IPv6 范围，避免图片 URL 被用于访问本机或内部服务。 */
const blockedAddresses = createBlockedAddressList()

/** 按地址族隔离的黑名单，避免运行时把 IPv4 映射后误命中 IPv6 规则。 */
interface BlockedAddressLists {
  ipv4: BlockList
  ipv6: BlockList
}

/** 安全下载远程图片，并对每次重定向重新执行协议与 DNS 边界校验。 */
export async function downloadSafeRemoteImage(
  rawUrl: string,
  dependencies: SafeRemoteImageDependencies = defaultDependencies,
  signal?: AbortSignal,
): Promise<DownloadedRemoteImage> {
  const maxBytes = dependencies.maxBytes ?? MAX_ATTACHMENT_SIZE
  const maxRedirects = dependencies.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('远程图片大小限制无效')
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw new Error('远程图片重定向限制无效')

  /** 当前跳 URL 只存在于本地循环，不进入错误日志。 */
  let currentUrl = parseRemoteImageUrl(rawUrl)
  let redirectCount = 0
  while (true) {
    signal?.throwIfAborted()
    assertHttpsUrl(currentUrl)
    /** 任一 DNS 结果不安全时拒绝整组，防止选择公网结果掩盖私网别名。 */
    const addresses = await resolveAndValidateAddresses(currentUrl.hostname, dependencies.lookup)
    signal?.throwIfAborted()
    /** 固定首个已验证地址，transport 不得再次解析域名。 */
    const selected = addresses[0]
    if (!selected) throw new Error('图片下载地址无法解析')
    const response = await dependencies.request({
      url: currentUrl,
      address: selected.address,
      family: selected.family,
      signal,
    })

    if (REDIRECT_STATUS_CODES.has(response.statusCode)) {
      response.cancel?.()
      if (redirectCount >= maxRedirects) throw new Error('远程图片重定向次数过多')
      const location = getHeader(response.headers, 'location')
      if (!location) throw new Error('远程图片重定向响应缺少地址')
      currentUrl = parseRemoteImageUrl(location, currentUrl)
      redirectCount += 1
      continue
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.cancel?.()
      throw new Error(`远程图片请求失败 (${response.statusCode})`)
    }
    const mediaType = normalizeImageMediaType(getHeader(response.headers, 'content-type'))
    if (!mediaType) {
      response.cancel?.()
      throw new Error('远程响应不是受支持的图片')
    }
    const declaredLength = parseContentLength(getHeader(response.headers, 'content-length'))
    if (declaredLength !== undefined && declaredLength > maxBytes) {
      response.cancel?.()
      throw new Error('远程图片超过大小限制')
    }
    return {
      bytes: await readLimitedBody(response, maxBytes, signal),
      mediaType,
    }
  }
}

/** 解析 URL 时只返回稳定错误，不回显可能含签名参数的原始字符串。 */
function parseRemoteImageUrl(rawUrl: string, baseUrl?: URL): URL {
  try {
    return new URL(rawUrl, baseUrl)
  } catch {
    throw new Error('远程图片地址无效')
  }
}

/** 只允许 HTTPS，避免图片内容或签名经明文链路泄露。 */
function assertHttpsUrl(url: URL): void {
  if (url.protocol !== 'https:') throw new Error('远程图片只允许使用 HTTPS')
  if (url.username || url.password) throw new Error('远程图片地址不允许包含用户凭据')
}

/** 解析全部地址并确保每个结果都属于可路由公网。 */
async function resolveAndValidateAddresses(
  hostname: string,
  lookup: SafeRemoteImageDependencies['lookup'],
): Promise<ResolvedAddress[]> {
  const normalizedHostname = stripIpv6Brackets(hostname)
  const literalFamily = isIP(normalizedHostname)
  /** IP 字面量无需 DNS，但仍进入相同的公网分类校验。 */
  const addresses: ResolvedAddress[] = literalFamily === 4 || literalFamily === 6
    ? [{ address: normalizedHostname, family: literalFamily }]
    : await lookup(normalizedHostname)
  if (addresses.length === 0) throw new Error('图片下载地址无法解析')
  for (const resolved of addresses) {
    if (isIP(resolved.address) !== resolved.family || isBlockedAddress(resolved)) {
      throw new Error('图片下载地址不允许访问本地或私有网络')
    }
  }
  return addresses
}

/** 判断地址是否命中本地、私网、保留、组播或文档用途网段。 */
function isBlockedAddress(resolved: ResolvedAddress): boolean {
  return resolved.family === 4
    ? blockedAddresses.ipv4.check(resolved.address, 'ipv4')
    : blockedAddresses.ipv6.check(resolved.address, 'ipv6')
}

/** 创建覆盖 IPv4/IPv6 非公网地址的只读黑名单。 */
function createBlockedAddressList(): BlockedAddressLists {
  const ipv4 = new BlockList()
  const ipv6 = new BlockList()
  for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) ipv4.addSubnet(address, prefix, 'ipv4')
  for (const [address, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['::', 96],
    ['::ffff:0:0', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001:2::', 48],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) ipv6.addSubnet(address, prefix, 'ipv6')
  return { ipv4, ipv6 }
}

/** 从大小写不敏感响应头中读取单个值。 */
function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const expected = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value
  }
  return undefined
}

/** 清洗 Content-Type 并收窄到附件服务支持的四类图片。 */
function normalizeImageMediaType(value: string | undefined): DownloadedRemoteImage['mediaType'] | undefined {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase()
  if (!mediaType
    || !SUPPORTED_REMOTE_IMAGE_TYPES.has(mediaType as DownloadedRemoteImage['mediaType'])) return undefined
  return mediaType as DownloadedRemoteImage['mediaType']
}

/** 解析可信的非负 Content-Length；无效值按未知长度处理并依靠流式限制。 */
function parseContentLength(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const length = Number(value)
  return Number.isSafeInteger(length) ? length : undefined
}

/** 流式读取响应并在累计字节超限的第一时间中止。 */
async function readLimitedBody(
  response: RemoteImageResponse,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  /** 分块保存避免在上限内反复复制完整 Buffer。 */
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted()
      const buffer = Buffer.from(chunk)
      totalBytes += buffer.length
      if (totalBytes > maxBytes) throw new Error('远程图片超过大小限制')
      chunks.push(buffer)
    }
    signal?.throwIfAborted()
    return Buffer.concat(chunks, totalBytes)
  } finally {
    response.cancel?.()
  }
}

/** 去除 URL.hostname 在 IPv6 字面量上可能保留的方括号。 */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** 生产 DNS 实现返回全部 A/AAAA，调用方会拒绝其中任一非公网地址。 */
async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const results = await lookupDns(hostname, { all: true, verbatim: true })
  return results.flatMap((result) => (
    result.family === 4 || result.family === 6
      ? [{ address: result.address, family: result.family }]
      : []
  ))
}

/** 生产 HTTPS transport 直接连接已验证 IP，同时保留原 Host 和 TLS servername。 */
function defaultRequest(
  input: Parameters<SafeRemoteImageDependencies['request']>[0],
): Promise<RemoteImageResponse> {
  return new Promise((resolve, reject) => {
    const originalHostname = stripIpv6Brackets(input.url.hostname)
    const request = requestHttps({
      protocol: 'https:',
      hostname: input.address,
      family: input.family,
      port: input.url.port || undefined,
      path: `${input.url.pathname}${input.url.search}`,
      method: 'GET',
      servername: isIP(originalHostname) === 0 ? originalHostname : undefined,
      headers: {
        Accept: 'image/png,image/jpeg,image/webp,image/gif',
        Host: input.url.host,
        Connection: 'close',
      },
      signal: input.signal,
    }, (response) => {
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: {
          'content-type': firstHeaderValue(response.headers['content-type']),
          'content-length': firstHeaderValue(response.headers['content-length']),
          location: firstHeaderValue(response.headers.location),
        },
        body: response,
        cancel: () => { response.destroy() },
      })
    })
    request.on('error', reject)
    request.end()
  })
}

/** 把 Node 多值响应头收窄为安全下载只使用的首个字符串。 */
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

const defaultDependencies: SafeRemoteImageDependencies = {
  lookup: defaultLookup,
  request: defaultRequest,
}
