import { isServerOpsId } from './server-ops'

/** Docker 领域 IPC 通道，集中定义以保持 Main、Preload 与 Renderer 一致。 */
export const SERVER_OPS_DOCKER_CHANNELS = {
  LIST_RESOURCES: 'server-ops:list-docker-resources',
  GET_CONTAINER_DETAIL: 'server-ops:get-docker-container-detail',
  PREPARE_ACTION: 'server-ops:prepare-docker-action',
  COMMIT_ACTION: 'server-ops:commit-docker-action',
  CANCEL_ACTION: 'server-ops:cancel-docker-action',
} as const

/** Docker 主机能力的稳定公开状态。 */
export type ServerOpsDockerCapability = 'available' | 'cli-missing' | 'daemon-unavailable' | 'permission-denied'
/** Docker 容器生命周期状态白名单。 */
export type ServerOpsDockerContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead'
/** 首版允许逐次确认的容器动作。 */
export type ServerOpsDockerAction = 'start' | 'stop' | 'restart'
/** Docker 公开端口协议。 */
export type ServerOpsDockerPortProtocol = 'tcp' | 'udp' | 'sctp'
/** Docker 公开挂载类型。 */
export type ServerOpsDockerMountType = 'bind' | 'volume' | 'tmpfs'

/** Docker 资源快照请求。 */
export interface ServerOpsDockerResourcesInput { hostId: string }

/** 容器列表使用的非敏感摘要。 */
export interface ServerOpsDockerContainerSummary {
  containerId: string
  names: string[]
  image: string
  imageId?: string
  state: ServerOpsDockerContainerState
  status: string
  createdAt: string
  publishedPorts: string[]
  mountNames: string[]
}

/** 镜像列表使用的非敏感摘要。 */
export interface ServerOpsDockerImageSummary {
  imageId: string
  repository: string
  tag: string
  digest: string
  createdAt: string
  size: string
}

/** 网络列表使用的非敏感摘要。 */
export interface ServerOpsDockerNetworkSummary {
  networkId: string
  name: string
  driver: string
  scope: string
  internal: boolean
}

/** 卷列表使用的非敏感摘要。 */
export interface ServerOpsDockerVolumeSummary {
  name: string
  driver: string
  scope: string
}

/** 当前主机的四类 Docker 资源快照。 */
export interface ServerOpsDockerResourcesResult {
  hostId: string
  capability: ServerOpsDockerCapability
  containers: ServerOpsDockerContainerSummary[]
  images: ServerOpsDockerImageSummary[]
  networks: ServerOpsDockerNetworkSummary[]
  volumes: ServerOpsDockerVolumeSummary[]
  warnings: string[]
}

/** 容器详情请求，只允许完整不可混淆 ID。 */
export interface ServerOpsDockerContainerDetailInput { hostId: string; containerId: string }

/** 容器端口公开投影。 */
export interface ServerOpsDockerPortBinding {
  privatePort: number
  protocol: ServerOpsDockerPortProtocol
  publicPort?: number
  address?: string
}

/** 容器挂载公开投影，刻意不包含服务器源路径。 */
export interface ServerOpsDockerMount {
  type: ServerOpsDockerMountType
  name?: string
  destination: string
  readOnly: boolean
}

/** inspect 结果的严格公开白名单。 */
export interface ServerOpsDockerContainerDetail {
  containerId: string
  name: string
  image: string
  imageId: string
  createdAt: string
  platform: string
  state: ServerOpsDockerContainerState
  running: boolean
  exitCode: number
  restartCount: number
  ports: ServerOpsDockerPortBinding[]
  mounts: ServerOpsDockerMount[]
}

/** 单容器详情结果。 */
export interface ServerOpsDockerContainerDetailResult {
  hostId: string
  capability: ServerOpsDockerCapability
  container?: ServerOpsDockerContainerDetail
  warnings: string[]
}

/** 用户准备逐次确认的 Docker 动作。 */
export interface ServerOpsDockerActionPrepareInput {
  hostId: string
  containerId: string
  action: ServerOpsDockerAction
}

/** Main 签发且绑定真实 inspect 快照的短期动作候选。 */
export interface ServerOpsDockerActionCandidate {
  candidateId: string
  hostId: string
  action: ServerOpsDockerAction
  container: ServerOpsDockerContainerDetail
  expiresAt: number
}

/** 提交或取消动作候选的公开输入。 */
export interface ServerOpsDockerActionCommitInput { hostId: string; candidateId: string }
export interface ServerOpsDockerActionCancelInput { hostId: string; candidateId: string }

/** Docker 动作完成后的只读回查结果。 */
export interface ServerOpsDockerActionResult {
  hostId: string
  containerId: string
  action: ServerOpsDockerAction
  container?: ServerOpsDockerContainerDetail
  warnings: string[]
}

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝公开 DTO 中的未知字段。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key))
}

/** 判断字符串是否有界且不含终端控制字符。 */
function isDisplayString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Docker 容器操作身份必须使用完整 64 位小写十六进制 ID。 */
export function isServerOpsDockerContainerId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

/** 镜像 ID 只接受 Docker 的完整 sha256 身份。 */
function isDockerImageId(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
}

/** Docker 网络 ID 使用完整 64 位十六进制身份。 */
function isDockerNetworkId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

/** Docker 容器、网络和卷名称只接受 daemon 自身允许的安全字符集。 */
function isDockerObjectName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)
}

/** 解析有界展示字符串数组并复制结果。 */
function parseStringArray(value: unknown, maximumItems: number, maximumLength: number, errorCode: string): string[] {
  if (!Array.isArray(value) || value.length > maximumItems
    || value.some((entry) => !isDisplayString(entry, maximumLength))) throw new Error(errorCode)
  return [...value]
}

/** 严格解析公开 warnings。 */
function parseWarnings(value: unknown, errorCode: string): string[] {
  return parseStringArray(value, 100, 512, errorCode)
}

/** 判断 Docker capability 枚举。 */
function isCapability(value: unknown): value is ServerOpsDockerCapability {
  return value === 'available' || value === 'cli-missing' || value === 'daemon-unavailable' || value === 'permission-denied'
}

/** 判断容器状态枚举。 */
function isContainerState(value: unknown): value is ServerOpsDockerContainerState {
  return value === 'created' || value === 'running' || value === 'paused' || value === 'restarting'
    || value === 'removing' || value === 'exited' || value === 'dead'
}

/** 判断容器动作枚举。 */
function isDockerAction(value: unknown): value is ServerOpsDockerAction {
  return value === 'start' || value === 'stop' || value === 'restart'
}

/** 解析主机 ID 单字段输入。 */
export function parseServerOpsDockerResourcesInput(value: unknown): ServerOpsDockerResourcesInput {
  const errorCode = 'SERVER_OPS_DOCKER_RESOURCES_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId'])) || !isServerOpsId(value.hostId)) throw new Error(errorCode)
  return { hostId: value.hostId }
}

/** 严格解析单个容器摘要。 */
function parseContainerSummary(value: unknown, errorCode: string): ServerOpsDockerContainerSummary {
  const keys = new Set(['containerId', 'names', 'image', 'imageId', 'state', 'status', 'createdAt', 'publishedPorts', 'mountNames'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isServerOpsDockerContainerId(value.containerId)
    || !isDisplayString(value.image, 512) || (value.imageId !== undefined && !isDockerImageId(value.imageId)) || !isContainerState(value.state)
    || !isDisplayString(value.status, 512, true) || !isDisplayString(value.createdAt, 128)) throw new Error(errorCode)
  const names = parseStringArray(value.names, 16, 128, errorCode)
  if (names.length < 1 || names.some((name) => !isDockerObjectName(name))) throw new Error(errorCode)
  return {
    containerId: value.containerId,
    names,
    image: value.image,
    ...(value.imageId === undefined ? {} : { imageId: value.imageId }),
    state: value.state,
    status: value.status,
    createdAt: value.createdAt,
    publishedPorts: parseStringArray(value.publishedPorts, 64, 256, errorCode),
    mountNames: parseStringArray(value.mountNames, 64, 128, errorCode),
  }
}

/** 严格解析单个镜像摘要。 */
function parseImageSummary(value: unknown, errorCode: string): ServerOpsDockerImageSummary {
  const keys = new Set(['imageId', 'repository', 'tag', 'digest', 'createdAt', 'size'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isDockerImageId(value.imageId)
    || !isDisplayString(value.repository, 512) || !isDisplayString(value.tag, 256)
    || !isDisplayString(value.digest, 256) || !isDisplayString(value.createdAt, 128)
    || !isDisplayString(value.size, 64)) throw new Error(errorCode)
  return { imageId: value.imageId, repository: value.repository, tag: value.tag, digest: value.digest, createdAt: value.createdAt, size: value.size }
}

/** 严格解析单个网络摘要。 */
function parseNetworkSummary(value: unknown, errorCode: string): ServerOpsDockerNetworkSummary {
  const keys = new Set(['networkId', 'name', 'driver', 'scope', 'internal'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isDockerNetworkId(value.networkId)
    || !isDockerObjectName(value.name) || !isDisplayString(value.driver, 64)
    || !isDisplayString(value.scope, 64) || typeof value.internal !== 'boolean') throw new Error(errorCode)
  return { networkId: value.networkId, name: value.name, driver: value.driver, scope: value.scope, internal: value.internal }
}

/** 严格解析单个卷摘要。 */
function parseVolumeSummary(value: unknown, errorCode: string): ServerOpsDockerVolumeSummary {
  const keys = new Set(['name', 'driver', 'scope'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isDockerObjectName(value.name)
    || !isDisplayString(value.driver, 64) || !isDisplayString(value.scope, 64)) throw new Error(errorCode)
  return { name: value.name, driver: value.driver, scope: value.scope }
}

/** 解析 Docker 四类资源快照并强制总量边界。 */
export function parseServerOpsDockerResourcesResult(value: unknown): ServerOpsDockerResourcesResult {
  const errorCode = 'SERVER_OPS_DOCKER_RESOURCES_RESULT_INVALID'
  const keys = new Set(['hostId', 'capability', 'containers', 'images', 'networks', 'volumes', 'warnings'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isServerOpsId(value.hostId) || !isCapability(value.capability)
    || !Array.isArray(value.containers) || value.containers.length > 500
    || !Array.isArray(value.images) || value.images.length > 500
    || !Array.isArray(value.networks) || value.networks.length > 256
    || !Array.isArray(value.volumes) || value.volumes.length > 512) throw new Error(errorCode)
  if (value.capability !== 'available'
    && (value.containers.length > 0 || value.images.length > 0 || value.networks.length > 0 || value.volumes.length > 0)) throw new Error(errorCode)
  return {
    hostId: value.hostId,
    capability: value.capability,
    containers: value.containers.map((entry) => parseContainerSummary(entry, errorCode)),
    images: value.images.map((entry) => parseImageSummary(entry, errorCode)),
    networks: value.networks.map((entry) => parseNetworkSummary(entry, errorCode)),
    volumes: value.volumes.map((entry) => parseVolumeSummary(entry, errorCode)),
    warnings: parseWarnings(value.warnings, errorCode),
  }
}

/** 严格解析单容器详情输入。 */
export function parseServerOpsDockerContainerDetailInput(value: unknown): ServerOpsDockerContainerDetailInput {
  const errorCode = 'SERVER_OPS_DOCKER_DETAIL_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'containerId'])) || !isServerOpsId(value.hostId)
    || !isServerOpsDockerContainerId(value.containerId)) throw new Error(errorCode)
  return { hostId: value.hostId, containerId: value.containerId }
}

/** 严格解析单个端口绑定。 */
function parsePort(value: unknown, errorCode: string): ServerOpsDockerPortBinding {
  const keys = new Set(['privatePort', 'protocol', 'publicPort', 'address'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !Number.isSafeInteger(value.privatePort)
    || typeof value.privatePort !== 'number' || value.privatePort < 1 || value.privatePort > 65_535
    || (value.protocol !== 'tcp' && value.protocol !== 'udp' && value.protocol !== 'sctp')
    || (value.publicPort !== undefined && (!Number.isSafeInteger(value.publicPort) || typeof value.publicPort !== 'number'
      || value.publicPort < 1 || value.publicPort > 65_535))
    || (value.address !== undefined && !isDisplayString(value.address, 128))) throw new Error(errorCode)
  return { privatePort: value.privatePort, protocol: value.protocol,
    ...(value.publicPort === undefined ? {} : { publicPort: value.publicPort }),
    ...(value.address === undefined ? {} : { address: value.address }) }
}

/** 严格解析单个挂载公开投影。 */
function parseMount(value: unknown, errorCode: string): ServerOpsDockerMount {
  const keys = new Set(['type', 'name', 'destination', 'readOnly'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys)
    || (value.type !== 'bind' && value.type !== 'volume' && value.type !== 'tmpfs')
    || (value.name !== undefined && !isDockerObjectName(value.name))
    || !isDisplayString(value.destination, 1_024) || !value.destination.startsWith('/')
    || typeof value.readOnly !== 'boolean') throw new Error(errorCode)
  return { type: value.type, ...(value.name === undefined ? {} : { name: value.name }), destination: value.destination, readOnly: value.readOnly }
}

/** 严格解析 inspect 白名单投影。 */
function parseContainerDetail(value: unknown, errorCode: string): ServerOpsDockerContainerDetail {
  const keys = new Set(['containerId', 'name', 'image', 'imageId', 'createdAt', 'platform', 'state', 'running', 'exitCode', 'restartCount', 'ports', 'mounts'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isServerOpsDockerContainerId(value.containerId)
    || !isDockerObjectName(value.name) || !isDisplayString(value.image, 512) || !isDockerImageId(value.imageId)
    || !isDisplayString(value.createdAt, 128) || !isDisplayString(value.platform, 64) || !isContainerState(value.state)
    || typeof value.running !== 'boolean' || !Number.isSafeInteger(value.exitCode) || typeof value.exitCode !== 'number'
    || value.exitCode < 0 || value.exitCode > 255 || !Number.isSafeInteger(value.restartCount)
    || typeof value.restartCount !== 'number' || value.restartCount < 0 || value.restartCount > 2_147_483_647
    || !Array.isArray(value.ports) || value.ports.length > 128
    || !Array.isArray(value.mounts) || value.mounts.length > 128) throw new Error(errorCode)
  return {
    containerId: value.containerId, name: value.name, image: value.image, imageId: value.imageId,
    createdAt: value.createdAt, platform: value.platform, state: value.state, running: value.running,
    exitCode: value.exitCode, restartCount: value.restartCount,
    ports: value.ports.map((entry) => parsePort(entry, errorCode)),
    mounts: value.mounts.map((entry) => parseMount(entry, errorCode)),
  }
}

/** 解析单容器详情结果。 */
export function parseServerOpsDockerContainerDetailResult(value: unknown): ServerOpsDockerContainerDetailResult {
  const errorCode = 'SERVER_OPS_DOCKER_DETAIL_RESULT_INVALID'
  const keys = new Set(['hostId', 'capability', 'container', 'warnings'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isServerOpsId(value.hostId) || !isCapability(value.capability)) throw new Error(errorCode)
  if (value.capability !== 'available' && value.container !== undefined) throw new Error(errorCode)
  return { hostId: value.hostId, capability: value.capability,
    ...(value.container === undefined ? {} : { container: parseContainerDetail(value.container, errorCode) }),
    warnings: parseWarnings(value.warnings, errorCode) }
}

/** 解析用户准备确认的 Docker 动作。 */
export function parseServerOpsDockerActionPrepareInput(value: unknown): ServerOpsDockerActionPrepareInput {
  const errorCode = 'SERVER_OPS_DOCKER_ACTION_PREPARE_INPUT_INVALID'
  const keys = new Set(['hostId', 'containerId', 'action'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isServerOpsId(value.hostId)
    || !isServerOpsDockerContainerId(value.containerId) || !isDockerAction(value.action)) throw new Error(errorCode)
  return { hostId: value.hostId, containerId: value.containerId, action: value.action }
}

/** 解析 Main 签发的 Docker 动作候选公开视图。 */
export function parseServerOpsDockerActionCandidate(value: unknown): ServerOpsDockerActionCandidate {
  const errorCode = 'SERVER_OPS_DOCKER_ACTION_CANDIDATE_INVALID'
  const keys = new Set(['candidateId', 'hostId', 'action', 'container', 'expiresAt'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isServerOpsId(value.candidateId)
    || !isServerOpsId(value.hostId) || !isDockerAction(value.action)
    || !Number.isSafeInteger(value.expiresAt) || typeof value.expiresAt !== 'number' || value.expiresAt < 0
    || value.expiresAt > 8_640_000_000_000_000) throw new Error(errorCode)
  return { candidateId: value.candidateId, hostId: value.hostId, action: value.action,
    container: parseContainerDetail(value.container, errorCode), expiresAt: value.expiresAt }
}

/** 解析候选提交输入。 */
export function parseServerOpsDockerActionCommitInput(value: unknown): ServerOpsDockerActionCommitInput {
  const errorCode = 'SERVER_OPS_DOCKER_ACTION_COMMIT_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'candidateId']))
    || !isServerOpsId(value.hostId) || !isServerOpsId(value.candidateId)) throw new Error(errorCode)
  return { hostId: value.hostId, candidateId: value.candidateId }
}

/** 解析候选取消输入。 */
export function parseServerOpsDockerActionCancelInput(value: unknown): ServerOpsDockerActionCancelInput {
  const errorCode = 'SERVER_OPS_DOCKER_ACTION_CANCEL_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['hostId', 'candidateId']))
    || !isServerOpsId(value.hostId) || !isServerOpsId(value.candidateId)) throw new Error(errorCode)
  return { hostId: value.hostId, candidateId: value.candidateId }
}

/** 解析 Docker 动作完成后的公开只读回查。 */
export function parseServerOpsDockerActionResult(value: unknown): ServerOpsDockerActionResult {
  const errorCode = 'SERVER_OPS_DOCKER_ACTION_RESULT_INVALID'
  const keys = new Set(['hostId', 'containerId', 'action', 'container', 'warnings'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isServerOpsId(value.hostId)
    || !isServerOpsDockerContainerId(value.containerId) || !isDockerAction(value.action)) throw new Error(errorCode)
  const container = value.container === undefined ? undefined : parseContainerDetail(value.container, errorCode)
  if (container && container.containerId !== value.containerId) throw new Error(errorCode)
  return { hostId: value.hostId, containerId: value.containerId, action: value.action,
    ...(container === undefined ? {} : { container }), warnings: parseWarnings(value.warnings, errorCode) }
}
