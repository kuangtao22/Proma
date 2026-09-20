/** 在途条目只保留 Promise 与订阅有效性，不缓存已结束的业务结果。 */
interface PendingRead {
  promise: Promise<unknown>
  subscribers: Array<() => boolean>
}

/** 相同资源 lane 顺序执行，防止快速切表撞上主进程单飞预算。 */
interface ReadLane {
  tail: Promise<unknown>
  pending: Map<string, PendingRead>
}

/** preload API 隔离协调域；测试、多个窗口与不同 API 不共享连接结果。 */
const readOwners = new WeakMap<object, Map<string, ReadLane>>()

/**
 * 合并同目标读取并顺序执行同资源 lane；排队期间所有订阅失效就跳过查询。
 * @param owner 同一 preload API
 * @param laneKey 主进程限制单飞的来源与读取类别
 * @param requestKey 含配置版本、库、表、分页的完整身份
 * @param read 实际 IPC 读取
 * @param isRelevant 当前订阅是否仍需要这份结果
 * @returns 共享在途回执；结束后立即释放，不长期缓存业务行
 */
export function enqueueServerOpsDataRead<T>(
  owner: object,
  laneKey: string,
  requestKey: string,
  read: () => Promise<T>,
  isRelevant: () => boolean,
): Promise<T> {
  /** 本协调域的资源列表。 */
  const lanes = readOwners.get(owner) ?? new Map<string, ReadLane>()
  readOwners.set(owner, lanes)
  /** 当前资源队列。 */
  const lane = lanes.get(laneKey) ?? { tail: Promise.resolve(), pending: new Map<string, PendingRead>() }
  lanes.set(laneKey, lane)
  /** 相同完整身份的在途或排队请求。 */
  const existing = lane.pending.get(requestKey)
  if (existing) {
    existing.subscribers.push(isRelevant)
    return existing.promise as Promise<T>
  }
  /** 重放 effect 可增加订阅，因此执行时再判断有效性。 */
  const subscribers = [isRelevant]
  /** 上一个请求失败也不阻塞后续 lane。 */
  const promise = lane.tail.then(() => {
    if (!subscribers.some((check) => check())) throw new Error('SERVER_OPS_DATA_READ_CANCELLED')
    return read()
  })
  /** 发布前注册，保证同一微任务内的重复调用也合并。 */
  const entry: PendingRead = { promise, subscribers }
  lane.pending.set(requestKey, entry)
  lane.tail = promise.then(() => undefined, () => undefined)
  /** 不通过未观察的 finally Promise 传播异常。 */
  const release = (): void => {
    if (lane.pending.get(requestKey) === entry) lane.pending.delete(requestKey)
    subscribers.length = 0
    if (lane.pending.size === 0 && lanes.get(laneKey) === lane) lanes.delete(laneKey)
  }
  void promise.then(release, release)
  return promise
}
