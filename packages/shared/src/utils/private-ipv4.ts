/** 严格判断地址是否属于 RFC1918 私有 IPv4 网段。 */
export function isRfc1918Ipv4(address: string): boolean {
  /** 拒绝前导零和非四段形式，避免不同解析器产生地址歧义。 */
  const segments = address.split('.')
  if (segments.length !== 4) return false
  /** 解析并校验每个十进制 octet。 */
  const octets = segments.map((segment) => {
    if (!/^(0|[1-9]\d{0,2})$/.test(segment)) return -1
    const value = Number(segment)
    return value <= 255 ? value : -1
  })
  if (octets.some(octet => octet < 0)) return false
  /** 首、次 octet 足以判断三个 RFC1918 网段。 */
  const first = octets[0]!
  const second = octets[1]!
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

/** 从候选地址中选择第一个严格 RFC1918 IPv4。 */
export function selectRfc1918Ipv4(addresses: readonly string[]): string | undefined {
  return addresses.find(isRfc1918Ipv4)
}
