#include <node_api.h>

#include <cerrno>
#include <cstddef>
#include <string>

#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#ifdef __APPLE__
#include <sys/mount.h>
#else
#include <sys/vfs.h>
#endif
#include <unistd.h>
#endif

namespace {

constexpr char kLockFileName[] = ".server-ops-config.lock";

/** 原生锁的错误分类，TS 层据此提供稳定能力错误。 */
constexpr char kInvalidDirectoryCode[] = "SERVER_OPS_CONFIG_LOCK_INVALID_DIRECTORY";
constexpr char kUnavailableCode[] = "SERVER_OPS_CONFIG_LOCK_UNAVAILABLE";

/** 从 Node-API 状态构造不可恢复异常。 */
void ThrowError(napi_env env, const char* code, const std::string& message) {
  napi_value text;
  napi_value error;
  napi_value code_value;
  napi_create_string_utf8(env, message.c_str(), message.size(), &text);
  napi_create_error(env, nullptr, text, &error);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  napi_set_named_property(env, error, "code", code_value);
  napi_throw(env, error);
}

/** 读取唯一 UTF-8 路径参数。 */
bool ReadDirectoryArgument(napi_env env, napi_callback_info info, std::string* directory) {
  std::size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type = napi_undefined;
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
    ThrowError(env, kInvalidDirectoryCode, "Server Ops 配置锁目录必须是绝对路径字符串");
    return false;
  }
  std::size_t length = 0;
  napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length);
  directory->resize(length + 1);
  napi_get_value_string_utf8(env, argv[0], directory->data(), length + 1, &length);
  directory->resize(length);
  return true;
}

/** 只接受末段为 server-ops 的绝对目录，阻断 addon 被泛化为任意文件锁。 */
bool IsFixedServerOpsDirectory(const std::string& directory) {
  if (directory.empty()) return false;
#ifdef _WIN32
  const bool absolute = (directory.size() >= 3 && directory[1] == ':'
      && (directory[2] == '\\' || directory[2] == '/'))
      || (directory.size() >= 2 && directory[0] == '\\' && directory[1] == '\\');
#else
  const bool absolute = directory.front() == '/';
#endif
  if (!absolute) return false;
  std::size_t end = directory.size();
  while (end > 0 && (directory[end - 1] == '/' || directory[end - 1] == '\\')) --end;
  const std::size_t separator = directory.find_last_of("/\\", end == 0 ? 0 : end - 1);
  const std::string basename = directory.substr(separator == std::string::npos ? 0 : separator + 1,
      end - (separator == std::string::npos ? 0 : separator + 1));
  return basename == "server-ops";
}

struct LockHandle {
#ifdef _WIN32
  HANDLE directory = INVALID_HANDLE_VALUE;
  HANDLE file = INVALID_HANDLE_VALUE;
  OVERLAPPED overlapped{};
#else
  int directory = -1;
  int file = -1;
  dev_t directory_device = 0;
  ino_t directory_inode = 0;
  dev_t file_device = 0;
  ino_t file_inode = 0;
#endif
  bool locked = false;
};

/**
 * Contract / 合同：只为遵守协议的 Proma 进程提供互斥，并在验证点检测持续的路径替换。
 * It does not prevent a same-user process from momentarily rebinding a path between verification
 * and a path-based write; callers must treat post-callback verification failure as outcome unknown.
 */

/** 显式释放时报告 OS unlock/close 失败；finalizer 可忽略结果但仍完成全部清理。 */
bool ReleaseLock(LockHandle* handle, std::string* error) {
  if (!handle) return true;
  bool success = true;
#ifdef _WIN32
  if (handle->locked && handle->file != INVALID_HANDLE_VALUE) {
    if (!UnlockFileEx(handle->file, 0, 1, 0, &handle->overlapped)) success = false;
  }
  handle->locked = false;
  if (handle->file != INVALID_HANDLE_VALUE && !CloseHandle(handle->file)) success = false;
  if (handle->directory != INVALID_HANDLE_VALUE && !CloseHandle(handle->directory)) success = false;
  handle->file = INVALID_HANDLE_VALUE;
  handle->directory = INVALID_HANDLE_VALUE;
#else
  if (handle->locked && handle->file >= 0 && flock(handle->file, LOCK_UN) != 0) success = false;
  handle->locked = false;
  if (handle->file >= 0 && close(handle->file) != 0) success = false;
  if (handle->directory >= 0 && close(handle->directory) != 0) success = false;
  handle->file = -1;
  handle->directory = -1;
#endif
  if (!success && error) *error = "Server Ops 配置锁无法确认已完整释放";
  return success;
}

/** JS 遗失显式 release 时仍随 GC/进程退出释放内核锁。 */
void FinalizeLock(napi_env, void* data, void*) {
  auto* handle = static_cast<LockHandle*>(data);
  ReleaseLock(handle, nullptr);
  delete handle;
}

/** 创建 `{ status }` 结果。 */
napi_value CreateStatus(napi_env env, const char* status) {
  napi_value result;
  napi_value value;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "status", value);
  return result;
}

#ifdef _WIN32

/** 严格 UTF-8 转 Windows 宽字符串。 */
bool Utf8ToWide(const std::string& value, std::wstring* output) {
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(),
      static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) return false;
  output->resize(static_cast<std::size_t>(length));
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(),
      static_cast<int>(value.size()), output->data(), length) == length;
}

/** Windows 只接受可识别的非远程卷；远程映射盘的锁可靠性不作承诺。 */
bool IsSupportedFilesystem(const std::wstring& directory) {
  wchar_t volume[MAX_PATH];
  if (!GetVolumePathNameW(directory.c_str(), volume, MAX_PATH)) return false;
  const UINT type = GetDriveTypeW(volume);
  return type == DRIVE_FIXED || type == DRIVE_REMOVABLE || type == DRIVE_RAMDISK;
}

/** 打开并非阻塞取得 Windows 配置锁。 */
bool TryAcquirePlatform(const std::string& directory, LockHandle* handle, bool* busy,
                        std::string* error) {
  std::wstring wide_directory;
  if (!Utf8ToWide(directory, &wide_directory) || !IsSupportedFilesystem(wide_directory)) {
    *error = "当前文件系统无法证明支持可靠配置锁";
    return false;
  }
  handle->directory = CreateFileW(wide_directory.c_str(), FILE_LIST_DIRECTORY | FILE_ADD_FILE
      | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  BY_HANDLE_FILE_INFORMATION directory_info{};
  if (handle->directory == INVALID_HANDLE_VALUE
      || !GetFileInformationByHandle(handle->directory, &directory_info)
      || (directory_info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
      || (directory_info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    *error = "Server Ops 配置目录不可安全打开";
    return false;
  }
  std::wstring lock_path = wide_directory;
  if (!lock_path.empty() && lock_path.back() != L'\\' && lock_path.back() != L'/') lock_path += L'\\';
  lock_path += L".server-ops-config.lock";
  handle->file = CreateFileW(lock_path.c_str(), GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  BY_HANDLE_FILE_INFORMATION file_info{};
  if (handle->file == INVALID_HANDLE_VALUE
      || !GetFileInformationByHandle(handle->file, &file_info)
      || (file_info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0
      || file_info.nNumberOfLinks != 1) {
    *error = "Server Ops 配置锁文件身份不安全";
    return false;
  }
  if (!LockFileEx(handle->file, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
      0, 1, 0, &handle->overlapped)) {
    const DWORD code = GetLastError();
    if (code == ERROR_LOCK_VIOLATION || code == ERROR_IO_PENDING) {
      *busy = true;
      return true;
    }
    *error = "当前文件系统无法取得可靠配置锁";
    return false;
  }
  handle->locked = true;
  return true;
}

#else

/** POSIX 拒绝明确的远程文件系统；无法证明本地时 fail closed。 */
bool IsSupportedFilesystem(int directory) {
#ifdef __APPLE__
  struct statfs state {};
  return fstatfs(directory, &state) == 0 && (state.f_flags & MNT_LOCAL) != 0;
#else
  struct statfs state {};
  if (fstatfs(directory, &state) != 0) return false;
  constexpr long kExtMagic = 0xEF53;
  constexpr long kXfsMagic = 0x58465342;
  constexpr long kBtrfsMagic = 0x9123683E;
  constexpr long kTmpfsMagic = 0x01021994;
  constexpr long kOverlayMagic = 0x794C7630;
  constexpr long kRamfsMagic = 0x858458F6;
  constexpr long kZfsMagic = 0x2FC12FC1;
  return state.f_type == kExtMagic || state.f_type == kXfsMagic
      || state.f_type == kBtrfsMagic || state.f_type == kTmpfsMagic
      || state.f_type == kOverlayMagic || state.f_type == kRamfsMagic
      || state.f_type == kZfsMagic;
#endif
}

/** 打开并非阻塞取得 POSIX 配置锁。 */
bool TryAcquirePlatform(const std::string& directory, LockHandle* handle, bool* busy,
                        std::string* error) {
  handle->directory = open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat directory_identity {};
  if (handle->directory < 0 || fstat(handle->directory, &directory_identity) != 0
      || !S_ISDIR(directory_identity.st_mode)) {
    *error = "Server Ops 配置目录不可安全打开";
    return false;
  }
  handle->directory_device = directory_identity.st_dev;
  handle->directory_inode = directory_identity.st_ino;
  if (!IsSupportedFilesystem(handle->directory)) {
    *error = "当前文件系统无法证明支持可靠配置锁";
    return false;
  }
  for (int attempt = 0; attempt < 32 && handle->file < 0; ++attempt) {
    handle->file = openat(handle->directory, kLockFileName,
        O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (handle->file >= 0) break;
    if (errno != EEXIST) break;
    handle->file = openat(handle->directory, kLockFileName,
        O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    if (handle->file >= 0) break;
    if (errno != ENOENT) break;
  }
  struct stat opened {};
  if (handle->file < 0 || fstat(handle->file, &opened) != 0
      || !S_ISREG(opened.st_mode) || opened.st_nlink != 1) {
    *error = "Server Ops 配置锁文件身份不安全";
    return false;
  }
  handle->file_device = opened.st_dev;
  handle->file_inode = opened.st_ino;
  if (flock(handle->file, LOCK_EX | LOCK_NB) != 0) {
    if (errno == EWOULDBLOCK || errno == EAGAIN) {
      *busy = true;
      return true;
    }
    *error = "当前文件系统无法取得可靠配置锁";
    return false;
  }
  handle->locked = true;
  struct stat path_identity {};
  if (fstatat(handle->directory, kLockFileName, &path_identity, AT_SYMLINK_NOFOLLOW) != 0
      || path_identity.st_dev != opened.st_dev || path_identity.st_ino != opened.st_ino) {
    *error = "Server Ops 配置锁文件在加锁期间被替换";
    return false;
  }
  return true;
}

#endif

/** 比较 Windows 文件身份中的卷与 64 位文件索引。 */
#ifdef _WIN32
bool SameWindowsIdentity(const BY_HANDLE_FILE_INFORMATION& left,
                         const BY_HANDLE_FILE_INFORMATION& right) {
  return left.dwVolumeSerialNumber == right.dwVolumeSerialNumber
      && left.nFileIndexHigh == right.nFileIndexHigh
      && left.nFileIndexLow == right.nFileIndexLow;
}
#endif

/** 验证当前路径仍指向取得锁时的目录和锁叶，持久替换一律 fail closed。 */
bool VerifyPlatform(const std::string& directory, LockHandle* handle, std::string* error) {
#ifdef _WIN32
  std::wstring wide_directory;
  if (!Utf8ToWide(directory, &wide_directory)) {
    *error = "Server Ops 配置目录身份已变化";
    return false;
  }
  HANDLE current_directory = CreateFileW(wide_directory.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  BY_HANDLE_FILE_INFORMATION directory_identity{};
  if (current_directory == INVALID_HANDLE_VALUE
      || !GetFileInformationByHandle(current_directory, &directory_identity)) {
    if (current_directory != INVALID_HANDLE_VALUE) CloseHandle(current_directory);
    *error = "Server Ops 配置目录身份已变化";
    return false;
  }
  CloseHandle(current_directory);
  std::wstring lock_path = wide_directory;
  if (!lock_path.empty() && lock_path.back() != L'\\' && lock_path.back() != L'/') lock_path += L'\\';
  lock_path += L".server-ops-config.lock";
  HANDLE current_file = CreateFileW(lock_path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  BY_HANDLE_FILE_INFORMATION file_identity{};
  if (current_file == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(current_file, &file_identity)) {
    if (current_file != INVALID_HANDLE_VALUE) CloseHandle(current_file);
    *error = "Server Ops 配置锁文件身份已变化";
    return false;
  }
  CloseHandle(current_file);
  BY_HANDLE_FILE_INFORMATION held_directory{};
  BY_HANDLE_FILE_INFORMATION held_file{};
  if (!GetFileInformationByHandle(handle->directory, &held_directory)
      || !GetFileInformationByHandle(handle->file, &held_file)
      || !SameWindowsIdentity(directory_identity, held_directory)
      || !SameWindowsIdentity(file_identity, held_file)
      || file_identity.nNumberOfLinks != 1) {
    *error = "Server Ops 配置锁路径身份已变化";
    return false;
  }
  return true;
#else
  int current_directory = open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat directory_identity {};
  struct stat held_file {};
  struct stat path_file {};
  const bool valid = current_directory >= 0
      && fstat(current_directory, &directory_identity) == 0
      && directory_identity.st_dev == handle->directory_device
      && directory_identity.st_ino == handle->directory_inode
      && fstat(handle->file, &held_file) == 0
      && held_file.st_dev == handle->file_device
      && held_file.st_ino == handle->file_inode
      && held_file.st_nlink == 1
      && fstatat(current_directory, kLockFileName, &path_file, AT_SYMLINK_NOFOLLOW) == 0
      && S_ISREG(path_file.st_mode)
      && path_file.st_dev == handle->file_device
      && path_file.st_ino == handle->file_inode
      && path_file.st_nlink == 1;
  if (current_directory >= 0) close(current_directory);
  if (!valid) *error = "Server Ops 配置锁路径身份已变化";
  return valid;
#endif
}

/** 单次尝试取得锁；争用返回 busy，其余不可靠条件抛能力错误。 */
napi_value TryAcquire(napi_env env, napi_callback_info info) {
  std::string directory;
  if (!ReadDirectoryArgument(env, info, &directory)) return nullptr;
  if (!IsFixedServerOpsDirectory(directory)) {
    ThrowError(env, kInvalidDirectoryCode, "只允许锁定固定 Server Ops 配置目录");
    return nullptr;
  }
  auto* handle = new LockHandle();
  bool busy = false;
  std::string error;
  if (!TryAcquirePlatform(directory, handle, &busy, &error)) {
    ReleaseLock(handle, nullptr);
    delete handle;
    ThrowError(env, kUnavailableCode, error);
    return nullptr;
  }
  if (busy) {
    ReleaseLock(handle, nullptr);
    delete handle;
    return CreateStatus(env, "busy");
  }
  napi_value external;
  napi_create_external(env, handle, FinalizeLock, nullptr, &external);
  napi_value result = CreateStatus(env, "acquired");
  napi_set_named_property(env, result, "handle", external);
  return result;
}

/** 从 external 读取锁句柄，并验证调用方传入的固定目录路径身份。 */
napi_value Verify(napi_env env, napi_callback_info info) {
  std::size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  void* data = nullptr;
  if (argc != 2 || napi_get_value_external(env, argv[0], &data) != napi_ok || !data) {
    ThrowError(env, kUnavailableCode, "Server Ops 配置锁句柄无效");
    return nullptr;
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, argv[1], &type) != napi_ok || type != napi_string) {
    ThrowError(env, kUnavailableCode, "Server Ops 配置锁目录无效");
    return nullptr;
  }
  std::size_t length = 0;
  napi_get_value_string_utf8(env, argv[1], nullptr, 0, &length);
  std::string directory(length + 1, '\0');
  napi_get_value_string_utf8(env, argv[1], directory.data(), length + 1, &length);
  directory.resize(length);
  std::string error;
  if (!VerifyPlatform(directory, static_cast<LockHandle*>(data), &error)) {
    ThrowError(env, kUnavailableCode, error);
    return nullptr;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

/** 显式释放当前 external 持有的锁。 */
napi_value Release(napi_env env, napi_callback_info info) {
  std::size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  void* data = nullptr;
  if (argc != 1 || napi_get_value_external(env, argv[0], &data) != napi_ok || !data) {
    ThrowError(env, kUnavailableCode, "Server Ops 配置锁句柄无效");
    return nullptr;
  }
  std::string error;
  if (!ReleaseLock(static_cast<LockHandle*>(data), &error)) {
    ThrowError(env, kUnavailableCode, error);
    return nullptr;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    { "tryAcquire", nullptr, TryAcquire, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "verify", nullptr, Verify, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
