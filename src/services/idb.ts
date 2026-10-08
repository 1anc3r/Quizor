/**
 * IndexedDB 极简封装：一个 string → string 的键值库，用来放体积最大的题库存档。
 *
 * 为什么必须搬出 localStorage：
 * - localStorage 同源配额只有 5MB 量级，且按 UTF-16 计（字符数 × 2）；
 * - 一个 880 题的题库 JSON 约 3.3MB，存进去要占 6.6MB —— 直接写不进去，
 *   于是"编辑内置大题库"根本无法保存（这是本项目最硬的一处容量天花板）；
 * - IDB 的配额通常是可用磁盘的很大一部分（数百 MB 起），且写入是异步的，
 *   而题库的读写路径本来就已是 async。
 *
 * 约定：IDB 里存**原始 JSON 字符串**（不存对象），这样：
 * 1) 迁移时读回即可逐字符比对，校验才真正有意义；
 * 2) 不走结构化克隆，大对象不必二次序列化。
 * key 与 localStorage 共用同一命名空间（含 PREFIX），便于备份/清空统一处理。
 *
 * 失败降级：任何一步出错都返回 null / false，绝不抛异常，由调用方回退到 localStorage。
 */
const DB_NAME = 'quizor'
const DB_VERSION = 1
const STORE = 'kv'

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    // 兜底超时：应用启动会 await 迁移，而个别浏览器在版本变更/隐私模式下
    // 可能既不触发 success 也不触发 error/blocked，不能让启动流程卡死
    const timer = setTimeout(() => {
      console.warn('[quizor] IndexedDB 打开超时，回退 localStorage')
      resolve(null)
    }, 3000)
    const done = (db: IDBDatabase | null): void => {
      clearTimeout(timer)
      resolve(db)
    }
    try {
      if (typeof indexedDB === 'undefined') {
        done(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => done(req.result)
      req.onerror = () => {
        console.warn('[quizor] IndexedDB 打开失败，回退 localStorage：', req.error)
        done(null)
      }
      // 其它标签页持有旧版本连接时会一直阻塞，不能让启动流程卡住
      req.onblocked = () => {
        console.warn('[quizor] IndexedDB 被其它标签页阻塞，回退 localStorage')
        done(null)
      }
    } catch (e) {
      console.warn('[quizor] IndexedDB 不可用，回退 localStorage：', e)
      done(null)
    }
  })
  return dbPromise
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 等待事务真正提交（配额类错误只在 abort/error 上暴露，不能只看请求回调） */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'))
  })
}

export async function idbGetRaw(key: string): Promise<string | null> {
  const db = await openDb()
  if (!db) return null
  try {
    const tx = db.transaction(STORE, 'readonly')
    const value = await request<unknown>(tx.objectStore(STORE).get(key))
    return typeof value === 'string' ? value : null
  } catch (e) {
    console.warn('[quizor] IndexedDB 读取失败：', key, e)
    return null
  }
}

export async function idbSetRaw(key: string, raw: string): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(raw, key)
    await transactionDone(tx)
    return true
  } catch (e) {
    console.warn('[quizor] IndexedDB 写入失败：', key, e)
    return false
  }
}

export async function idbDelete(key: string): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    await transactionDone(tx)
    return true
  } catch (e) {
    console.warn('[quizor] IndexedDB 删除失败：', key, e)
    return false
  }
}

export async function idbKeys(): Promise<string[] | null> {
  const db = await openDb()
  if (!db) return null
  try {
    const tx = db.transaction(STORE, 'readonly')
    const keys = await request<IDBValidKey[]>(tx.objectStore(STORE).getAllKeys())
    return keys.filter((k): k is string => typeof k === 'string')
  } catch (e) {
    console.warn('[quizor] IndexedDB 枚举失败：', e)
    return null
  }
}

export interface IdbEntry {
  key: string
  /** key + 原始 JSON 的字符数（× 2 ≈ 占用字节） */
  chars: number
}

/** 列出全部条目及占用（读全部值只为算体积；仅设置页按需调用） */
export async function idbEntries(): Promise<IdbEntry[] | null> {
  const db = await openDb()
  if (!db) return null
  try {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    // 两个请求必须在同一轮事件循环内发出，否则事务会在等待期间自动提交
    const [keys, values] = await Promise.all([
      request<IDBValidKey[]>(store.getAllKeys()),
      request<unknown[]>(store.getAll())
    ])
    return keys
      .map((k, i) => ({
        key: typeof k === 'string' ? k : String(k),
        chars: (typeof k === 'string' ? k.length : 0) + (typeof values[i] === 'string' ? (values[i] as string).length : 0)
      }))
      .sort((a, b) => b.chars - a.chars)
  } catch (e) {
    console.warn('[quizor] IndexedDB 统计失败：', e)
    return null
  }
}

export async function idbClear(): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await transactionDone(tx)
    return true
  } catch (e) {
    console.warn('[quizor] IndexedDB 清空失败：', e)
    return false
  }
}

let availability: Promise<boolean> | null = null

/**
 * 探测 IDB 是否真的可写。
 * 只判断 open 成功是不够的：Safari 无痕模式下能打开，但写入立刻失败。
 */
export function idbAvailable(): Promise<boolean> {
  if (availability) return availability
  availability = (async () => {
    const probe = `quizor:__probe__`
    if (!(await idbSetRaw(probe, '1'))) return false
    const readBack = await idbGetRaw(probe)
    await idbDelete(probe)
    return readBack === '1'
  })()
  return availability
}
