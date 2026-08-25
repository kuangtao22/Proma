#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#else
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace {

constexpr int kProtocol = 1;

struct Config {
  std::string mode = "list";
  std::vector<std::string> roots;
  int max_depth = 10;
  std::size_t max_entries = 10000;
  std::size_t max_output_bytes = 16 * 1024 * 1024;
  std::set<std::string> ignore_directories;
  std::set<std::string> ignore_files;
};

struct EntryBudget {
  std::size_t entries = 0;
  std::size_t output_bytes = 0;
};

// 转义 UTF-8 JSON 字符串；输入原始文本，返回可安全嵌入 JSON 的内容。
std::string JsonEscape(const std::string& value) {
  std::ostringstream out;
  for (unsigned char ch : value) {
    switch (ch) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20) {
          const char* hex = "0123456789abcdef";
          out << "\\u00" << hex[(ch >> 4) & 0xf] << hex[ch & 0xf];
        } else {
          out << static_cast<char>(ch);
        }
    }
  }
  return out.str();
}

// 在总输出预算内写入一行；输入协议行与预算，返回是否完整写出。
bool EmitLine(const std::string& line, const Config& config, EntryBudget* budget) {
  const std::size_t bytes = line.size() + 1;
  if (budget->output_bytes + bytes > config.max_output_bytes) return false;
  budget->output_bytes += bytes;
  std::cout << line << '\n';
  std::cout.flush();
  return std::cout.good();
}

// 解析非负整数参数；输入文本与输出指针，返回参数是否合法。
bool ParseUnsigned(const std::string& raw, std::size_t* output) {
  if (raw.empty()) return false;
  char* end = nullptr;
  const unsigned long long value = std::strtoull(raw.c_str(), &end, 10);
  if (!end || *end != '\0') return false;
  *output = static_cast<std::size_t>(value);
  return true;
}

// 解析 helper 命令行；输入 argv，填充配置或错误信息并返回成功状态。
bool ParseArguments(const std::vector<std::string>& args, Config* config, std::string* error) {
  for (std::size_t index = 0; index < args.size(); ++index) {
    const std::string& key = args[index];
    if (index + 1 >= args.size()) {
      *error = "missing value for " + key;
      return false;
    }
    const std::string value = args[++index];
    if (key == "--mode") {
      if (value != "list" && value != "scan") {
        *error = "unsupported mode";
        return false;
      }
      config->mode = value;
    } else if (key == "--root") {
      config->roots.push_back(value);
    } else if (key == "--max-depth") {
      std::size_t parsed = 0;
      if (!ParseUnsigned(value, &parsed) || parsed > 64) {
        *error = "invalid max depth";
        return false;
      }
      config->max_depth = static_cast<int>(parsed);
    } else if (key == "--max-entries") {
      if (!ParseUnsigned(value, &config->max_entries) || config->max_entries > 100000) {
        *error = "invalid max entries";
        return false;
      }
    } else if (key == "--max-output-bytes") {
      if (!ParseUnsigned(value, &config->max_output_bytes) || config->max_output_bytes > 64 * 1024 * 1024) {
        *error = "invalid output budget";
        return false;
      }
    } else if (key == "--ignore-dir") {
      config->ignore_directories.insert(value);
    } else if (key == "--ignore-file") {
      config->ignore_files.insert(value);
    } else {
      *error = "unknown argument: " + key;
      return false;
    }
  }
  if (config->roots.empty()) {
    *error = "at least one root is required";
    return false;
  }
  return true;
}

// 提取跨平台路径末段；输入完整路径，返回文件或目录名。
std::string BaseName(const std::string& path) {
  const std::size_t position = path.find_last_of("/\\");
  return position == std::string::npos ? path : path.substr(position + 1);
}

// 使用当前平台分隔符拼接路径；输入父路径与名称，返回展示路径。
std::string JoinPath(const std::string& parent, const std::string& name) {
#ifdef _WIN32
  const char separator = '\\';
#else
  const char separator = '/';
#endif
  if (!parent.empty() && (parent.back() == '/' || parent.back() == '\\')) return parent + name;
  return parent + separator + name;
}

// 序列化单条目录结果；输入根索引、名称、路径和类型大小，返回 JSON 行。
std::string EntryJson(std::size_t root_index, const std::string& name, const std::string& path,
                      bool is_directory, std::uint64_t size) {
  std::ostringstream out;
  out << "{\"type\":\"entry\",\"rootIndex\":" << root_index
      << ",\"name\":\"" << JsonEscape(name) << "\",\"path\":\"" << JsonEscape(path)
      << "\",\"isDirectory\":" << (is_directory ? "true" : "false");
  if (!is_directory) out << ",\"size\":" << size;
  out << '}';
  return out.str();
}

#ifndef _WIN32

// 独占 POSIX 文件描述符，离开作用域时自动关闭。
class UniqueFd {
 public:
  explicit UniqueFd(int value = -1) : value_(value) {}
  ~UniqueFd() { Reset(); }
  UniqueFd(const UniqueFd&) = delete;
  UniqueFd& operator=(const UniqueFd&) = delete;
  UniqueFd(UniqueFd&& other) noexcept : value_(other.Release()) {}
  UniqueFd& operator=(UniqueFd&& other) noexcept {
    if (this != &other) Reset(other.Release());
    return *this;
  }
  int Get() const { return value_; }
  int Release() { const int value = value_; value_ = -1; return value; }
  void Reset(int value = -1) { if (value_ >= 0) close(value_); value_ = value; }
 private:
  int value_;
};

// 保存授权前已打开的 POSIX root、canonical 路径与稳定身份。
struct StableRoot {
  std::string requested_path;
  std::string canonical_path;
  struct stat identity {};
  UniqueFd descriptor;
};

// 从已打开 fd 解析 canonical 路径；输入 fd 与输出指针，返回解析状态。
bool CanonicalPathForFd(int descriptor, std::string* output) {
#ifdef __APPLE__
  char path[PATH_MAX];
  if (fcntl(descriptor, F_GETPATH, path) != 0) return false;
  *output = path;
  return true;
#else
  const std::string link = "/proc/self/fd/" + std::to_string(descriptor);
  char path[PATH_MAX];
  const ssize_t length = readlink(link.c_str(), path, sizeof(path) - 1);
  if (length < 0) return false;
  path[length] = '\0';
  *output = path;
  return true;
#endif
}

// 以 no-follow 方式打开 root；输入请求路径，返回稳定对象或错误。
bool OpenStableRoot(const std::string& requested_path, StableRoot* root, std::string* error) {
  UniqueFd descriptor(open(requested_path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
  if (descriptor.Get() < 0) {
    *error = "cannot open root";
    return false;
  }
  struct stat identity {};
  if (fstat(descriptor.Get(), &identity) != 0 || (!S_ISDIR(identity.st_mode) && !S_ISREG(identity.st_mode))) {
    *error = "root is not a regular file or directory";
    return false;
  }
  std::string canonical_path;
  if (!CanonicalPathForFd(descriptor.Get(), &canonical_path)) {
    *error = "cannot resolve opened root";
    return false;
  }
  root->requested_path = requested_path;
  root->canonical_path = canonical_path;
  root->identity = identity;
  root->descriptor = std::move(descriptor);
  return true;
}

// 在条目和字节预算内输出 POSIX 条目；返回是否仍可继续协议输出。
bool EmitEntry(const Config& config, EntryBudget* budget, std::size_t root_index,
               const std::string& name, const std::string& path, const struct stat& identity) {
  if (budget->entries >= config.max_entries) return true;
  if (!EmitLine(EntryJson(root_index, name, path, S_ISDIR(identity.st_mode),
                          static_cast<std::uint64_t>(identity.st_size)), config, budget)) return false;
  ++budget->entries;
  return true;
}

// 仅通过父 fd 递归枚举目录；输入稳定 fd、展示路径与深度，返回遍历状态。
bool TraverseDirectory(const Config& config, EntryBudget* budget, std::size_t root_index,
                       int directory_fd, const std::string& canonical_path, int depth) {
  UniqueFd duplicate(dup(directory_fd));
  if (duplicate.Get() < 0) return false;
  DIR* raw_directory = fdopendir(duplicate.Release());
  if (!raw_directory) return false;
  std::unique_ptr<DIR, int (*)(DIR*)> directory(raw_directory, closedir);
  while (dirent* item = readdir(directory.get())) {
    if (budget->entries >= config.max_entries) return true;
    const std::string name(item->d_name);
    if (name == "." || name == ".." || config.ignore_files.count(name) > 0) continue;
    struct stat listed_identity {};
    if (fstatat(directory_fd, name.c_str(), &listed_identity, AT_SYMLINK_NOFOLLOW) != 0) continue;
    if (S_ISLNK(listed_identity.st_mode) || (!S_ISDIR(listed_identity.st_mode) && !S_ISREG(listed_identity.st_mode))) continue;
    if (S_ISDIR(listed_identity.st_mode) && config.ignore_directories.count(name) > 0) continue;
    const int flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | (S_ISDIR(listed_identity.st_mode) ? O_DIRECTORY : 0);
    UniqueFd child(openat(directory_fd, name.c_str(), flags));
    if (child.Get() < 0) continue;
    struct stat opened_identity {};
    if (fstat(child.Get(), &opened_identity) != 0
        || opened_identity.st_dev != listed_identity.st_dev
        || opened_identity.st_ino != listed_identity.st_ino
        || (opened_identity.st_mode & S_IFMT) != (listed_identity.st_mode & S_IFMT)) continue;
    const std::string child_path = JoinPath(canonical_path, name);
    if (!EmitEntry(config, budget, root_index, name, child_path, opened_identity)) return false;
    if (S_ISDIR(opened_identity.st_mode) && depth < config.max_depth) {
      if (!TraverseDirectory(config, budget, root_index, child.Get(), child_path, depth + 1)) return false;
    }
  }
  return true;
}

// 序列化全部已打开 POSIX roots；输入稳定 roots，返回 OPENED JSON 行。
std::string OpenedJson(const std::vector<StableRoot>& roots) {
  std::ostringstream out;
  out << "{\"type\":\"opened\",\"protocol\":" << kProtocol << ",\"roots\":[";
  for (std::size_t index = 0; index < roots.size(); ++index) {
    if (index > 0) out << ',';
    const StableRoot& root = roots[index];
    out << "{\"requestedPath\":\"" << JsonEscape(root.requested_path)
        << "\",\"canonicalPath\":\"" << JsonEscape(root.canonical_path)
        << "\",\"isDirectory\":" << (S_ISDIR(root.identity.st_mode) ? "true" : "false");
    if (S_ISREG(root.identity.st_mode)) out << ",\"size\":" << static_cast<std::uint64_t>(root.identity.st_size);
    out << ",\"volume\":\"" << root.identity.st_dev << "\",\"fileId\":\"" << root.identity.st_ino << "\"}";
  }
  out << "]}";
  return out.str();
}

// 执行 POSIX 两阶段协议；输入解析后的配置，返回进程退出码。
int RunPlatform(const Config& config) {
  std::vector<StableRoot> roots(config.roots.size());
  for (std::size_t index = 0; index < config.roots.size(); ++index) {
    std::string error;
    if (!OpenStableRoot(config.roots[index], &roots[index], &error)) {
      std::cerr << error << ": " << config.roots[index] << '\n';
      return 2;
    }
  }
  EntryBudget budget;
  if (!EmitLine(OpenedJson(roots), config, &budget)) return 4;
  std::string decision;
  if (!std::getline(std::cin, decision) || decision != "ALLOW") return 3;
  for (std::size_t index = 0; index < roots.size(); ++index) {
    const StableRoot& root = roots[index];
    if (S_ISREG(root.identity.st_mode)) {
      if (!EmitEntry(config, &budget, index, BaseName(root.canonical_path), root.canonical_path, root.identity)) return 4;
    } else if (!TraverseDirectory(config, &budget, index, root.descriptor.Get(), root.canonical_path, 0)) {
      return 4;
    }
  }
  std::ostringstream done;
  done << "{\"type\":\"done\",\"entryCount\":" << budget.entries << '}';
  return EmitLine(done.str(), config, &budget) ? 0 : 4;
}

#else

// 把 Windows UTF-16 文本转换为 UTF-8；输入宽字符串，返回 UTF-8 文本。
std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string output(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), output.data(), size, nullptr, nullptr);
  return output;
}

// 把 UTF-8 文本严格转换为 Windows UTF-16；输入 UTF-8，返回宽字符串。
std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) return {};
  std::wstring output(size, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), output.data(), size);
  return output;
}

// 独占 Windows HANDLE，离开作用域时自动关闭。
class UniqueHandle {
 public:
  explicit UniqueHandle(HANDLE value = INVALID_HANDLE_VALUE) : value_(value) {}
  ~UniqueHandle() { Reset(); }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  UniqueHandle(UniqueHandle&& other) noexcept : value_(other.Release()) {}
  UniqueHandle& operator=(UniqueHandle&& other) noexcept { if (this != &other) Reset(other.Release()); return *this; }
  HANDLE Get() const { return value_; }
  HANDLE Release() { HANDLE value = value_; value_ = INVALID_HANDLE_VALUE; return value; }
  void Reset(HANDLE value = INVALID_HANDLE_VALUE) { if (value_ != INVALID_HANDLE_VALUE) CloseHandle(value_); value_ = value; }
 private:
  HANDLE value_;
};

// 保存授权前已打开的 Windows root、canonical 路径与稳定身份。
struct StableRoot {
  std::string requested_path;
  std::string canonical_path;
  std::wstring canonical_wide;
  BY_HANDLE_FILE_INFORMATION identity {};
  UniqueHandle handle;
};

// 合并 Windows 文件 ID 高低位；输入句柄身份，返回稳定 64 位 ID。
std::uint64_t WindowsFileId(const BY_HANDLE_FILE_INFORMATION& identity) {
  return (static_cast<std::uint64_t>(identity.nFileIndexHigh) << 32) | identity.nFileIndexLow;
}

// 以禁止跟随 reparse point 的方式打开 root；返回稳定对象或错误。
bool OpenStableRoot(const std::string& requested_path, StableRoot* root, std::string* error) {
  const std::wstring requested = Utf8ToWide(requested_path);
  if (requested.empty()) { *error = "invalid UTF-8 root"; return false; }
  UniqueHandle handle(CreateFileW(requested.c_str(), FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (handle.Get() == INVALID_HANDLE_VALUE) { *error = "cannot open root"; return false; }
  BY_HANDLE_FILE_INFORMATION identity {};
  if (!GetFileInformationByHandle(handle.Get(), &identity)
      || (identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    *error = "root is a reparse point or unavailable";
    return false;
  }
  std::vector<wchar_t> final_path(32768);
  const DWORD length = GetFinalPathNameByHandleW(handle.Get(), final_path.data(), static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED);
  if (length == 0 || length >= final_path.size()) { *error = "cannot resolve opened root"; return false; }
  std::wstring canonical(final_path.data(), length);
  if (canonical.rfind(L"\\\\?\\", 0) == 0) canonical.erase(0, 4);
  root->requested_path = requested_path;
  root->canonical_path = WideToUtf8(canonical);
  root->canonical_wide = canonical;
  root->identity = identity;
  root->handle = std::move(handle);
  return true;
}

// 比较 Windows canonical 边界；输入候选与 root，返回候选是否位于 root 内。
bool IsWithinRoot(const std::wstring& candidate, const std::wstring& root) {
  if (candidate.size() < root.size()) return false;
  if (_wcsnicmp(candidate.c_str(), root.c_str(), root.size()) != 0) return false;
  return candidate.size() == root.size() || candidate[root.size()] == L'\\' || root.back() == L'\\';
}

// 通过目录 HANDLE 递归枚举并复核子对象身份；返回遍历是否完整成功。
bool TraverseDirectory(const Config& config, EntryBudget* budget, std::size_t root_index,
                       HANDLE directory, const std::wstring& canonical_path,
                       const std::wstring& authorized_root, int depth) {
  std::vector<unsigned char> buffer(64 * 1024);
  bool restart = true;
  while (true) {
    if (!GetFileInformationByHandleEx(directory,
        restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
        buffer.data(), static_cast<DWORD>(buffer.size()))) {
      return GetLastError() == ERROR_NO_MORE_FILES;
    }
    restart = false;
    unsigned char* cursor = buffer.data();
    while (true) {
      auto* item = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(cursor);
      const std::wstring name(item->FileName, item->FileNameLength / sizeof(wchar_t));
      if (name != L"." && name != L"..") {
        const std::string utf8_name = WideToUtf8(name);
        const bool is_directory = (item->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if ((item->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0
            && config.ignore_files.count(utf8_name) == 0
            && (!is_directory || config.ignore_directories.count(utf8_name) == 0)) {
          const std::wstring child_path = canonical_path + L"\\" + name;
          StableRoot child;
          std::string error;
          if (OpenStableRoot(WideToUtf8(child_path), &child, &error)
              && IsWithinRoot(child.canonical_wide, authorized_root)
              && WindowsFileId(child.identity) == static_cast<std::uint64_t>(item->FileId.QuadPart)
              && ((child.identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == is_directory) {
            const std::uint64_t size = (static_cast<std::uint64_t>(child.identity.nFileSizeHigh) << 32) | child.identity.nFileSizeLow;
            if (budget->entries >= config.max_entries) return true;
            if (!EmitLine(EntryJson(root_index, utf8_name, child.canonical_path, is_directory, size), config, budget)) return false;
            ++budget->entries;
            if (is_directory && depth < config.max_depth
                && !TraverseDirectory(config, budget, root_index, child.handle.Get(), child.canonical_wide, authorized_root, depth + 1)) return false;
          }
        }
      }
      if (item->NextEntryOffset == 0) break;
      cursor += item->NextEntryOffset;
    }
  }
}

// 序列化全部已打开 Windows roots；输入稳定 roots，返回 OPENED JSON 行。
std::string OpenedJson(const std::vector<StableRoot>& roots) {
  std::ostringstream out;
  out << "{\"type\":\"opened\",\"protocol\":" << kProtocol << ",\"roots\":[";
  for (std::size_t index = 0; index < roots.size(); ++index) {
    if (index > 0) out << ',';
    const StableRoot& root = roots[index];
    const bool is_directory = (root.identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    const std::uint64_t size = (static_cast<std::uint64_t>(root.identity.nFileSizeHigh) << 32) | root.identity.nFileSizeLow;
    out << "{\"requestedPath\":\"" << JsonEscape(root.requested_path)
        << "\",\"canonicalPath\":\"" << JsonEscape(root.canonical_path)
        << "\",\"isDirectory\":" << (is_directory ? "true" : "false");
    if (!is_directory) out << ",\"size\":" << size;
    out << ",\"volume\":\"" << root.identity.dwVolumeSerialNumber
        << "\",\"fileId\":\"" << WindowsFileId(root.identity) << "\"}";
  }
  out << "]}";
  return out.str();
}

// 执行 Windows 两阶段协议；输入解析后的配置，返回进程退出码。
int RunPlatform(const Config& config) {
  std::vector<StableRoot> roots(config.roots.size());
  for (std::size_t index = 0; index < config.roots.size(); ++index) {
    std::string error;
    if (!OpenStableRoot(config.roots[index], &roots[index], &error)) { std::cerr << error << '\n'; return 2; }
  }
  EntryBudget budget;
  if (!EmitLine(OpenedJson(roots), config, &budget)) return 4;
  std::string decision;
  if (!std::getline(std::cin, decision) || decision != "ALLOW") return 3;
  for (std::size_t index = 0; index < roots.size(); ++index) {
    const StableRoot& root = roots[index];
    const bool is_directory = (root.identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    if (!is_directory) {
      const std::uint64_t size = (static_cast<std::uint64_t>(root.identity.nFileSizeHigh) << 32) | root.identity.nFileSizeLow;
      if (!EmitLine(EntryJson(index, BaseName(root.canonical_path), root.canonical_path, false, size), config, &budget)) return 4;
      ++budget.entries;
    } else if (!TraverseDirectory(config, &budget, index, root.handle.Get(), root.canonical_wide, root.canonical_wide, 0)) return 4;
  }
  std::ostringstream done;
  done << "{\"type\":\"done\",\"entryCount\":" << budget.entries << '}';
  return EmitLine(done.str(), config, &budget) ? 0 : 4;
}

#endif

// 解析参数并分派当前平台实现；输入 argv，返回稳定协议退出码。
int Run(const std::vector<std::string>& args) {
  Config config;
  std::string error;
  if (!ParseArguments(args, &config, &error)) {
    std::cerr << error << '\n';
    return 1;
  }
  return RunPlatform(config);
}

}  // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
  std::vector<std::string> args;
  for (int index = 1; index < argc; ++index) args.push_back(WideToUtf8(argv[index]));
  return Run(args);
}
#else
int main(int argc, char** argv) {
  std::vector<std::string> args;
  for (int index = 1; index < argc; ++index) args.emplace_back(argv[index]);
  return Run(args);
}
#endif
