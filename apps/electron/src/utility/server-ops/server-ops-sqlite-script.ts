/**
 * 远端 SQLite 读取程序。
 *
 * 程序文本固定进入 `python3 -I -S -c`；文件路径、SQL 与分页参数只通过 stdin JSON 传入。
 * Python 侧再次执行路径、对象、authorizer、VM 步数、wall clock 与输出预算校验，避免 TypeScript
 * 调用链变化后扩大读取边界。
 */
import { SERVER_OPS_DATA_QUERY_TIMEOUT_MS } from '@proma/shared'

export const SERVER_OPS_SQLITE_REMOTE_SCRIPT = String.raw`
import json, math, os, re, signal, stat, sys, threading, time, urllib.parse

try:
    import sqlite3
except ImportError:
    sys.stdout.write('{"ok":false,"code":"SERVER_OPS_SQLITE_MODULE_UNAVAILABLE"}')
    sys.stdout.flush()
    raise SystemExit(0)

MAX_OUTPUT_BYTES = 1100000
MAX_CELL_LENGTH = 256
MAX_COLUMNS = 64
MAX_TABLES = 500
MAX_ROW_FILTERS = 12
MAX_ROW_FILTER_VALUE_LENGTH = 1024
SENSITIVE_PATTERN = re.compile(r'(pass(word)?|secret|token|api[_-]?key|credential|private[_-]?key|authorization|cookie|session)', re.I)

def emit(value):
    """输出单个有界 JSON envelope；入参为公开结果对象，无返回值。"""
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if len(raw.encode('utf-8')) > MAX_OUTPUT_BYTES:
        raw = json.dumps({'ok': False, 'code': 'SERVER_OPS_SQLITE_RESULT_TOO_LARGE'}, separators=(',', ':'))
    sys.stdout.write(raw)
    sys.stdout.flush()

def fail(code):
    """输出稳定错误码并结束进程；入参为白名单错误码，不返回。"""
    emit({'ok': False, 'code': code})
    raise SystemExit(0)

def clean_text(value, maximum):
    """清理展示文本控制字符；入参为原值和字符上限，返回有界字符串。"""
    text = re.sub(r'[\x00-\x1f\x7f]', ' ', str(value))
    return text[:maximum]

def sensitive(name):
    """判断列名是否敏感；入参为列名，返回是否需要遮罩。"""
    if SENSITIVE_PATTERN.search(name):
        return True
    normalized = re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', name).lower()
    normalized = re.sub(r'[^a-z0-9]+', '_', normalized)
    parts = [part for part in normalized.split('_') if part]
    if any(part in {'pass', 'password', 'passwd', 'pwd', 'passphrase', 'token', 'secret', 'credential'} for part in parts):
        return True
    return 'key' in parts and any(part in {'api', 'access', 'private', 'client', 'auth', 'session', 'encryption', 'signing'} for part in parts)

def format_cell(value, masked=False):
    """归一化 SQLite 单元格；入参为原值和遮罩标记，返回公开单元格。"""
    if masked:
        return '***'
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {'kind': 'binary', 'bytes': len(value)}
    if isinstance(value, bool):
        return 'true' if value else 'false'
    text = clean_text(value, 1000000)
    if len(text) <= MAX_CELL_LENGTH:
        return text
    return {'kind': 'text', 'text': text[:MAX_CELL_LENGTH], 'truncated': True}

def quote_identifier(value):
    """按 SQLite 规则引用标识符；入参为已验证名称，返回安全 SQL 片段。"""
    return '"' + value.replace('"', '""') + '"'

def row_filter_clause(filters, columns):
    """校验筛选合同和实时列元数据；入参为 JSON 条件与列名，返回 SQL 子句和绑定参数。"""
    if not isinstance(filters, dict) or set(filters) != {'match', 'conditions'} or filters['match'] not in ('all', 'any'):
        fail('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
    conditions = filters['conditions']
    if not isinstance(conditions, list) or not 1 <= len(conditions) <= MAX_ROW_FILTERS:
        fail('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
    operators = {'eq': '=', 'ne': '<>', 'gt': '>', 'gte': '>=', 'lt': '<', 'lte': '<='}
    patterns = {'contains', 'not-contains', 'starts-with', 'ends-with'}
    pieces, values = [], []
    for condition in conditions:
        if not isinstance(condition, dict) or not {'column', 'operator'} <= set(condition):
            fail('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
        operator = condition['operator']
        if not isinstance(operator, str):
            fail('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
        null_operator = operator in ('is-null', 'is-not-null')
        expected = {'column', 'operator'} if null_operator else {'column', 'operator', 'value'}
        column = condition['column']
        if (set(condition) != expected or not isinstance(column, str) or not 1 <= len(column) <= 128
            or re.search(r'[\x00-\x1f\x7f]', column) or column not in columns or sensitive(column)):
            fail('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
        quoted = quote_identifier(column)
        if null_operator:
            pieces.append(quoted + (' IS NULL' if operator == 'is-null' else ' IS NOT NULL'))
            continue
        value = condition['value']
        if not isinstance(value, str) or len(value.encode('utf-16-le', 'surrogatepass')) // 2 > MAX_ROW_FILTER_VALUE_LENGTH:
            fail('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
        if operator in patterns:
            escaped = value.replace('!', '!!').replace('%', '!%').replace('_', '!_')
            pattern = ('%' if operator in ('contains', 'not-contains', 'ends-with') else '') + escaped
            pattern += '%' if operator in ('contains', 'not-contains', 'starts-with') else ''
            pieces.append(quoted + (' NOT LIKE' if operator == 'not-contains' else ' LIKE') + " ? ESCAPE '!'")
            values.append(pattern)
        elif operator in operators:
            pieces.append(quoted + ' ' + operators[operator] + ' ?')
            values.append(value)
        else:
            fail('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
    return ' WHERE (' + (' AND ' if filters['match'] == 'all' else ' OR ').join(pieces) + ')', values

def read_object(name):
    """读取 main 库对象元数据；入参为对象名，返回 sqlite_schema 行或稳定失败。"""
    row = connection.execute(
        "SELECT name, type, sql FROM main.sqlite_schema WHERE name = ? AND type IN ('table', 'view') LIMIT 1",
        (name,),
    ).fetchone()
    if row is None or str(row[0]) != name:
        fail('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
    return row

def read_columns(name):
    """读取非隐藏列元数据；入参为表名，返回 table_xinfo 行列表。"""
    rows = connection.execute('PRAGMA main.table_xinfo(' + quote_identifier(name) + ')').fetchall()
    return [row for row in rows if len(row) >= 7 and int(row[6] or 0) == 0]

def fit_rows_to_budget(rows, maximum_bytes):
    """压缩文本以保留全部页内行；入参为行集和字节预算，返回行集与截断标记。"""
    if len(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) <= maximum_bytes:
        return rows, False
    def fit(maximum_text):
        """按统一字符上限裁剪文本；入参为字符数，返回保持行列形状的新行集。"""
        fitted = []
        for row in rows:
            fitted_row = []
            for cell in row:
                if isinstance(cell, str) and len(cell) > maximum_text:
                    fitted_row.append({'kind': 'text', 'text': cell[:maximum_text], 'truncated': True})
                elif isinstance(cell, dict) and cell.get('kind') == 'text' and len(cell.get('text', '')) > maximum_text:
                    fitted_row.append({'kind': 'text', 'text': cell['text'][:maximum_text], 'truncated': True})
                else:
                    fitted_row.append(cell)
            fitted.append(fitted_row)
        return fitted
    lower, upper = 0, MAX_CELL_LENGTH
    best = fit(0)
    while lower <= upper:
        middle = (lower + upper) // 2
        candidate = fit(middle)
        if len(json.dumps(candidate, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) <= maximum_bytes:
            best = candidate
            lower = middle + 1
        else:
            upper = middle - 1
    return best, True

def read_bounded_rows(cursor, column_names, maximum_rows, maximum_bytes, preserve_rows=False):
    """逐行消费游标并应用预算；入参含列名和上限，返回行、更多状态及截断事实。"""
    rows = []
    cell_truncated = False
    result_truncated = False
    has_more = False
    for raw_row in cursor:
        if len(rows) >= maximum_rows:
            has_more = True
            result_truncated = True
            break
        row = [format_cell(value, sensitive(column_names[index])) for index, value in enumerate(raw_row)]
        row_truncated = any(isinstance(cell, dict) and cell.get('kind') == 'text' for cell in row)
        candidate = rows + [row]
        if not preserve_rows and len(json.dumps(candidate, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > maximum_bytes:
            result_truncated = True
            break
        rows.append(row)
        cell_truncated = cell_truncated or row_truncated
    if preserve_rows:
        rows, budget_truncated = fit_rows_to_budget(rows, maximum_bytes)
        result_truncated = result_truncated or budget_truncated
    return rows, has_more, cell_truncated, result_truncated

def table_summary(search=None):
    """读取用户表与视图目录；有搜索词时按名称绑定过滤，返回最多 501 条。"""
    rows = connection.execute(
        "SELECT name, type FROM main.sqlite_schema WHERE type IN ('table', 'view') "
        "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' "
        + ("AND instr(lower(name), lower(?)) > 0 " if search is not None else "")
        + "ORDER BY name LIMIT ?",
        (search, MAX_TABLES + 1) if search is not None else (MAX_TABLES + 1,),
    ).fetchall()
    return rows

def install_limits():
    """安装 SQLite 连接级资源上限；无入参且无返回值。"""
    limits = [
        ('SQLITE_LIMIT_LENGTH', 1048576),
        ('SQLITE_LIMIT_SQL_LENGTH', 16384),
        ('SQLITE_LIMIT_COLUMN', 2000),
        ('SQLITE_LIMIT_EXPR_DEPTH', 32),
        ('SQLITE_LIMIT_COMPOUND_SELECT', 0),
        ('SQLITE_LIMIT_VDBE_OP', 200000),
        ('SQLITE_LIMIT_FUNCTION_ARG', 32),
        ('SQLITE_LIMIT_ATTACHED', 0),
        ('SQLITE_LIMIT_LIKE_PATTERN_LENGTH', 2050),
        ('SQLITE_LIMIT_VARIABLE_NUMBER', 64),
    ]
    for constant_name, value in limits:
        constant = getattr(sqlite3, constant_name, None)
        if constant is not None:
            connection.setlimit(constant, value)

def install_query_authorizer(allowed_tables, has_wildcard):
    """安装查询 authorizer；入参为表白名单和通配符标记，无返回值。"""
    denied_actions = {
        getattr(sqlite3, name) for name in (
            'SQLITE_INSERT', 'SQLITE_UPDATE', 'SQLITE_DELETE', 'SQLITE_CREATE_INDEX', 'SQLITE_CREATE_TABLE',
            'SQLITE_CREATE_TEMP_INDEX', 'SQLITE_CREATE_TEMP_TABLE', 'SQLITE_CREATE_TEMP_TRIGGER',
            'SQLITE_CREATE_TEMP_VIEW', 'SQLITE_CREATE_TRIGGER', 'SQLITE_CREATE_VIEW', 'SQLITE_DROP_INDEX',
            'SQLITE_DROP_TABLE', 'SQLITE_DROP_TEMP_INDEX', 'SQLITE_DROP_TEMP_TABLE', 'SQLITE_DROP_TEMP_TRIGGER',
            'SQLITE_DROP_TEMP_VIEW', 'SQLITE_DROP_TRIGGER', 'SQLITE_DROP_VIEW', 'SQLITE_ALTER_TABLE',
            'SQLITE_REINDEX', 'SQLITE_ANALYZE', 'SQLITE_ATTACH', 'SQLITE_DETACH', 'SQLITE_PRAGMA',
            'SQLITE_TRANSACTION', 'SQLITE_SAVEPOINT',
        ) if hasattr(sqlite3, name)
    }
    safe_functions = {
        'count', 'sum', 'avg', 'min', 'max', 'round', 'abs', 'coalesce', 'ifnull', 'nullif',
        'lower', 'upper', 'length', 'substring', 'substr', 'date', 'datetime', 'strftime',
        'trim', 'ltrim', 'rtrim', 'replace', 'like',
    }
    read_action = getattr(sqlite3, 'SQLITE_READ')
    function_action = getattr(sqlite3, 'SQLITE_FUNCTION')

    def authorize(action, arg1, arg2, database, source):
        """判定单次 SQLite 操作；入参为 authorizer 上下文，返回允许或拒绝常量。"""
        if action in denied_actions:
            return sqlite3.SQLITE_DENY
        if action == read_action:
            table = str(arg1 or '')
            column = str(arg2 or '')
            aggregate_probe = database is None and column == ''
            if (database != 'main' and not aggregate_probe) or table not in allowed_tables or table.startswith('sqlite_'):
                return sqlite3.SQLITE_DENY
            if sensitive(column) and not has_wildcard:
                return sqlite3.SQLITE_DENY
        if action == function_action:
            function_name = str(arg2 or arg1 or '').lower()
            if function_name not in safe_functions:
                return sqlite3.SQLITE_DENY
        if action not in {read_action, function_action, getattr(sqlite3, 'SQLITE_SELECT')}:
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    connection.set_authorizer(authorize)

def execute_request(payload):
    """执行已校验读取请求；入参为 stdin payload，返回公开 runtime 结果。"""
    mode = payload['mode']
    version = 'SQLite ' + sqlite3.sqlite_version + ' (Python ' + sys.version.split()[0] + ')'
    if mode == 'probe':
        connection.execute('SELECT COUNT(*) FROM main.sqlite_schema').fetchone()
        return {'capability': 'available', 'serverVersion': version, 'metrics': [], 'tables': [], 'warnings': []}

    if mode == 'diagnostics':
        page_size = int(connection.execute('PRAGMA main.page_size').fetchone()[0])
        page_count = int(connection.execute('PRAGMA main.page_count').fetchone()[0])
        object_rows = table_summary()
        metrics = [
            {'id': 'file-size', 'label': '文件大小', 'value': str(file_size) + ' B'},
            {'id': 'page-size', 'label': '页大小', 'value': str(page_size) + ' B'},
            {'id': 'page-count', 'label': '页面数', 'value': str(page_count)},
            {'id': 'table-count', 'label': '表与视图', 'value': str(len(object_rows))},
        ]
        tables = [{
            'id': 'database-objects', 'title': '数据库对象',
            'columns': [{'id': 'name', 'label': '名称'}, {'id': 'type', 'label': '类型'}],
            'rows': [[clean_text(row[0], 128), '视图' if row[1] == 'view' else '表'] for row in object_rows[:200]],
            'truncated': len(object_rows) > 200, 'emptyText': '没有用户表或视图',
        }]
        return {'capability': 'available', 'serverVersion': version, 'metrics': metrics, 'tables': tables, 'warnings': []}

    if mode == 'schema-tables':
        rows = table_summary(payload.get('schemaTableSearch'))
        return {
            'mode': mode, 'capability': 'available', 'database': 'main', 'databases': ['main'],
            'tables': [{'name': clean_text(row[0], 128), 'type': 'view' if row[1] == 'view' else 'table'} for row in rows[:MAX_TABLES]],
            **({'tablesTruncated': True} if len(rows) > MAX_TABLES else {}), 'warnings': [],
        }

    if mode == 'sql-query':
        allowed_tables = set(payload['allowedTables'])
        for allowed_table in allowed_tables:
            row = read_object(allowed_table)
            creation_sql = str(row[2] or '').upper()
            if row[1] != 'table' or creation_sql.startswith('CREATE VIRTUAL TABLE'):
                fail('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
        install_query_authorizer(allowed_tables, payload['hasWildcard'])
        started_at = time.monotonic()
        cursor = connection.execute(payload['sql'])
        descriptions = cursor.description or []
        if len(descriptions) > MAX_COLUMNS:
            fail('SERVER_OPS_DATA_QUERY_TOO_MANY_COLUMNS')
        # 原始列名用于敏感判断；展示列头的长度上限不能削掉敏感后缀。
        column_names = [str(item[0] or '') for item in descriptions]
        columns = [clean_text(name, 128) for name in column_names]
        rows, has_more, truncated_cells, budget_truncated = read_bounded_rows(cursor, column_names, payload['maxRows'], 24576)
        return {
            'queryId': payload['queryId'], 'database': 'main', 'columns': columns, 'rows': rows,
            'rowCount': len(rows), 'durationMs': max(0, int((time.monotonic() - started_at) * 1000)),
            'truncated': has_more or truncated_cells or budget_truncated,
            'warnings': ['部分单元格内容过长，已截断'] if truncated_cells else [],
        }

    table_name = payload.get('schemaTable')
    if not isinstance(table_name, str):
        fail('SERVER_OPS_SQLITE_TABLE_REQUIRED')
    table_object = read_object(table_name)
    # Agent 只接受普通物理表；视图和虚拟表可能间接引用禁用表。
    if payload.get('baseTablesOnly') and (
        table_object[1] != 'table' or str(table_object[2] or '').upper().startswith('CREATE VIRTUAL TABLE')
    ):
        fail('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
    column_rows = read_columns(table_name)

    if mode == 'schema-table':
        columns = []
        for row in column_rows[:256]:
            declared_type = clean_text(row[2] or 'BLOB', 128) or 'BLOB'
            column = {
                'name': clean_text(row[1], 128), 'type': declared_type, 'nullable': not bool(row[3]),
                'primaryKey': int(row[5] or 0) > 0,
            }
            if row[4] is not None:
                column['defaultText'] = clean_text(row[4], 256)
            columns.append(column)
        indexes = []
        if table_object[1] == 'table':
            for index_row in connection.execute('PRAGMA main.index_list(' + quote_identifier(table_name) + ')'):
                if len(indexes) >= 128:
                    break
                index_name = str(index_row[1])
                names = []
                for index_column in connection.execute('PRAGMA main.index_info(' + quote_identifier(index_name) + ')'):
                    if len(names) >= 16:
                        break
                    if index_column[2] is not None:
                        names.append(clean_text(index_column[2], 128))
                if names:
                    indexes.append({'name': clean_text(index_name, 128), 'unique': bool(index_row[2]), 'columns': names})
        return {'mode': mode, 'capability': 'available', 'columns': columns, 'indexes': indexes, 'warnings': []}

    if mode == 'schema-rows':
        creation_sql = str(table_object[2] or '').upper()
        if table_object[1] != 'table' or creation_sql.startswith('CREATE VIRTUAL TABLE'):
            fail('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
        offset = payload['rowOffset']
        limit = payload['rowLimit']
        shown_columns = column_rows[:MAX_COLUMNS]
        # 保留完整列名给遮罩判断，公开列头仍遵守 128 字符展示上限。
        column_names = [str(row[1]) for row in shown_columns]
        columns = [clean_text(name, 128) for name in column_names]
        primary_columns = [row for row in shown_columns if int(row[5] or 0) > 0]
        primary_columns.sort(key=lambda row: int(row[5]))
        select_columns = ', '.join(quote_identifier(str(row[1])) for row in shown_columns)
        order_clause = '' if not primary_columns else ' ORDER BY ' + ', '.join(quote_identifier(str(row[1])) for row in primary_columns)
        where_clause, values = ('', []) if 'rowFilters' not in payload else row_filter_clause(
            payload['rowFilters'], {str(row[1]) for row in column_rows})
        sql = 'SELECT ' + select_columns + ' FROM main.' + quote_identifier(table_name) + where_clause + order_clause + ' LIMIT ? OFFSET ?'
        cursor = connection.execute(sql, (*values, limit + 1, offset))
        rows, has_more, truncated_cells, budget_truncated = read_bounded_rows(cursor, column_names, limit, 1000000, True)
        return {
            'mode': mode, 'capability': 'available', 'columns': columns, 'rows': rows,
            'offset': offset, 'limit': limit, 'truncated': len(column_rows) > MAX_COLUMNS or truncated_cells or budget_truncated,
            'hasMore': has_more, 'orderedByPrimaryKey': bool(primary_columns),
            'warnings': ['表列数超过 64，当前预览只显示前 64 列'] if len(column_rows) > MAX_COLUMNS else [],
        }

    fail('SERVER_OPS_SQLITE_MODE_UNSUPPORTED')

if sys.version_info < (3, 11):
    fail('SERVER_OPS_SQLITE_PYTHON_VERSION_UNSUPPORTED')

boot_timer = threading.Timer(20, lambda: os._exit(124))
boot_timer.daemon = True
boot_timer.start()
try:
    payload = json.loads(sys.stdin.buffer.readline(65537))
except Exception:
    fail('SERVER_OPS_SQLITE_REQUEST_INVALID')

path = payload.get('filePath')
if not isinstance(path, str) or not path.startswith('/') or '\x00' in path:
    fail('SERVER_OPS_SQLITE_PATH_INVALID')
# 查询模式使用共享执行预算，结构读取保留原十五秒上限。
requested_timeout_ms = max(250, int(payload.get('timeoutMs', ${SERVER_OPS_DATA_QUERY_TIMEOUT_MS})))
timeout_cap_ms = ${SERVER_OPS_DATA_QUERY_TIMEOUT_MS} if payload.get('mode') in ('sql-query', 'schema-rows') else 15000
timeout_ms = min(timeout_cap_ms, requested_timeout_ms)
boot_timer.cancel()
hard_timer = threading.Timer(timeout_ms / 1000, lambda: os._exit(124))
hard_timer.daemon = True
hard_timer.start()
try:
    path_stat = os.stat(path, follow_symlinks=True)
except FileNotFoundError:
    fail('SERVER_OPS_SQLITE_FILE_NOT_FOUND')
except PermissionError:
    fail('SERVER_OPS_SQLITE_FILE_PERMISSION_DENIED')
except OSError:
    fail('SERVER_OPS_SQLITE_FILE_UNAVAILABLE')
if not stat.S_ISREG(path_stat.st_mode):
    fail('SERVER_OPS_SQLITE_FILE_NOT_REGULAR')
if not os.access(path, os.R_OK):
    fail('SERVER_OPS_SQLITE_FILE_PERMISSION_DENIED')
file_size = max(0, int(path_stat.st_size))
deadline = time.monotonic() + timeout_ms / 1000

def alarm_handler(_signum, _frame):
    """处理中断式墙钟超时；信号参数仅满足回调签名，始终抛出超时。"""
    raise TimeoutError()

if hasattr(signal, 'SIGALRM') and hasattr(signal, 'setitimer'):
    signal.signal(signal.SIGALRM, alarm_handler)
    signal.setitimer(signal.ITIMER_REAL, timeout_ms / 1000)

connection = None
try:
    uri = 'file:' + urllib.parse.quote(path, safe='/') + '?mode=ro'
    connection = sqlite3.connect(uri, uri=True, timeout=min(timeout_ms, 2000) / 1000)
    connection.execute('PRAGMA query_only = ON')
    connection.execute('PRAGMA trusted_schema = OFF')
    connection.execute('PRAGMA busy_timeout = ' + str(min(timeout_ms, 2000)))
    if hasattr(connection, 'enable_load_extension'):
        connection.enable_load_extension(False)
    install_limits()
    progress_calls = 0
    def progress():
        """执行 VM 步数与软截止检查；无入参，返回 SQLite 中断标记。"""
        global progress_calls
        progress_calls += 1
        return 1 if progress_calls > 20000 or time.monotonic() >= deadline else 0
    connection.set_progress_handler(progress, 1000)
    emit({'ok': True, 'result': execute_request(payload)})
except TimeoutError:
    fail('SERVER_OPS_DATA_QUERY_TIMEOUT')
except sqlite3.OperationalError as error:
    text = str(error).lower()
    if 'unable to open database file' in text:
        fail('SERVER_OPS_SQLITE_FILE_UNAVAILABLE')
    if 'interrupted' in text:
        fail('SERVER_OPS_DATA_QUERY_TIMEOUT')
    if 'locked' in text or 'busy' in text:
        fail('SERVER_OPS_SQLITE_DATABASE_LOCKED')
    if 'not authorized' in text or 'authorization denied' in text:
        fail('SERVER_OPS_DATA_QUERY_PERMISSION_DENIED')
    if 'no such table' in text:
        fail('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
    if 'no such column' in text:
        fail('SERVER_OPS_DATA_QUERY_COLUMN_UNAVAILABLE')
    if payload.get('mode') == 'sql-query':
        fail('SERVER_OPS_DATA_QUERY_SQL_INVALID')
    fail('SERVER_OPS_SQLITE_DATABASE_INVALID')
except PermissionError:
    fail('SERVER_OPS_SQLITE_FILE_PERMISSION_DENIED')
except sqlite3.DatabaseError as error:
    text = str(error).lower()
    # 单条记录超过读取预算不代表文件损坏，使用可操作的大小错误。
    if 'too big' in text:
        fail('SERVER_OPS_SQLITE_RESULT_TOO_LARGE')
    if 'interrupted' in text:
        fail('SERVER_OPS_DATA_QUERY_TIMEOUT')
    if 'not authorized' in text or 'authorization denied' in text:
        fail('SERVER_OPS_DATA_QUERY_PERMISSION_DENIED')
    fail('SERVER_OPS_SQLITE_DATABASE_INVALID')
except SystemExit:
    raise
except Exception:
    fail('SERVER_OPS_SQLITE_READ_FAILED')
finally:
    hard_timer.cancel()
    if connection is not None:
        try:
            connection.close()
        except Exception:
            pass
    if hasattr(signal, 'setitimer'):
        signal.setitimer(signal.ITIMER_REAL, 0)
`
