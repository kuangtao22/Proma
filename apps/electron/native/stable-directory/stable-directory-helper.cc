#include <algorithm>
#include <cerrno>
#include <climits>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <memory>
#include <random>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#else
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif
#include <unistd.h>
#endif

namespace {

constexpr int kProtocol = 1;
constexpr char kCanvasIntentLockName[] = ".canvas-intent.lock";
constexpr char kCanvasContentLockName[] = ".content.lock";
constexpr std::size_t kCanvasContentMaxFileBytes = 256 * 1024;

// 仅把 Win32 明确的文件或路径不存在错误归类为 missing。
[[maybe_unused]] bool IsCanvasWindowsMissingError(unsigned long error_code) {
  return error_code == 2UL || error_code == 3UL;
}

// Windows 目录 flush 只有系统调用成功才可声明耐久，错误码仅供测试分类完整性。
[[maybe_unused]] bool IsCanvasWindowsDirectoryFlushDurable(bool flush_succeeded, unsigned long) {
  return flush_succeeded;
}

struct Config {
  std::string mode = "list";
  std::vector<std::string> roots;
  int max_depth = 10;
  std::size_t max_entries = 10000;
  std::size_t max_output_bytes = 16 * 1024 * 1024;
  std::set<std::string> ignore_directories;
  std::set<std::string> ignore_files;
  std::string child_name;
  std::string entry_id;
  std::string destination_child_name;
  std::string destination_entry_id;
  std::string file_name;
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
      if (value != "list" && value != "scan"
          && value != "canvas-intent-scan" && value != "canvas-intent-write"
          && value != "canvas-content-write" && value != "canvas-content-read"
          && value != "canvas-content-list" && value != "canvas-content-move") {
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
    } else if (key == "--child-name") {
      config->child_name = value;
    } else if (key == "--entry-id") {
      config->entry_id = value;
    } else if (key == "--destination-child-name") {
      config->destination_child_name = value;
    } else if (key == "--destination-entry-id") {
      config->destination_entry_id = value;
    } else if (key == "--file-name") {
      config->file_name = value;
    } else {
      *error = "unknown argument: " + key;
      return false;
    }
  }
  if (config->roots.empty()) {
    *error = "at least one root is required";
    return false;
  }
  const bool canvas_mode = config->mode == "canvas-intent-scan" || config->mode == "canvas-intent-write";
  if (canvas_mode && (config->roots.size() != 1 || config->child_name != "transactions")) {
    *error = "invalid canvas intent directory contract";
    return false;
  }
  if (config->mode == "canvas-intent-write"
      && (config->file_name.empty()
          || config->file_name.find('/') != std::string::npos
          || config->file_name.find('\\') != std::string::npos)) {
    *error = "invalid canvas intent file contract";
    return false;
  }
  const bool content_mode = config->mode.rfind("canvas-content-", 0) == 0;
  const bool safe_child = config->child_name == "nodes" || config->child_name == "trash";
  const bool needs_entry = config->mode != "canvas-content-list";
  const bool needs_file = config->mode == "canvas-content-write"
      || config->mode == "canvas-content-read";
  const bool safe_file = config->file_name == "config.json" || config->file_name == "meta.json"
      || config->file_name == "content.md" || config->file_name == "index.html"
      || config->file_name == "entry.json";
  const bool fields_match_mode = config->mode == "canvas-content-write"
      ? config->destination_child_name.empty() && config->destination_entry_id.empty()
      : config->mode == "canvas-content-read"
        ? config->destination_child_name.empty() && config->destination_entry_id.empty()
        : config->mode == "canvas-content-list"
          ? config->entry_id.empty() && config->destination_child_name.empty()
              && config->destination_entry_id.empty() && config->file_name.empty()
          : config->file_name.empty();
  if (content_mode && (config->roots.size() != 1 || !safe_child
      || config->max_entries == 0 || config->max_entries > 512 || !fields_match_mode
      || (needs_entry && (config->entry_id.empty() || config->entry_id.size() > 128))
      || (needs_file && !safe_file)
      || (config->mode == "canvas-content-move"
          && ((config->destination_child_name != "nodes" && config->destination_child_name != "trash")
              || config->destination_child_name == config->child_name
              || config->destination_entry_id.empty()
              || config->destination_entry_id.size() > 128)))) {
    *error = "invalid canvas content directory contract";
    return false;
  }
  if (content_mode && needs_entry) {
    for (unsigned char value : config->entry_id) {
      if (!((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
          || (value >= '0' && value <= '9') || value == '_' || value == '-')) {
        *error = "invalid canvas content entry id";
        return false;
      }
    }
  }
  if (content_mode && config->mode == "canvas-content-move") {
    for (unsigned char value : config->destination_entry_id) {
      if (!((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
          || (value >= '0' && value <= '9') || value == '_' || value == '-')) {
        *error = "invalid canvas content destination entry id";
        return false;
      }
    }
  }
  return true;
}

// 解码授权后 stdin 携带的 Base64 正文；输入编码文本、字节上限与输出指针。
bool DecodeBase64(const std::string& encoded, std::size_t max_bytes, std::string* output) {
  static constexpr char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  int table[256];
  std::fill(std::begin(table), std::end(table), -1);
  for (int index = 0; index < 64; ++index) table[static_cast<unsigned char>(kAlphabet[index])] = index;
  output->clear();
  std::uint32_t value = 0;
  int bits = 0;
  bool padding = false;
  for (unsigned char ch : encoded) {
    if (ch == '=') {
      padding = true;
      continue;
    }
    if (padding || table[ch] < 0) return false;
    value = (value << 6) | static_cast<std::uint32_t>(table[ch]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output->push_back(static_cast<char>((value >> bits) & 0xff));
      value &= bits == 0 ? 0 : ((std::uint32_t{1} << bits) - 1);
      if (output->size() > max_bytes) return false;
    }
  }
  return true;
}

// 判断 ASCII 十六进制字符；用于跨平台锁定 UUID 文件名合同。
bool IsHexDigit(char value) {
  return (value >= '0' && value <= '9')
      || (value >= 'a' && value <= 'f')
      || (value >= 'A' && value <= 'F');
}

// 只接受固定 Agent 创建、Agent 重建、内容节点和批量事务 UUID 文件名。
bool IsCanvasIntentCandidateName(const std::string& name) {
  constexpr std::size_t kAgentRebuildPrefixLength = 19;
  constexpr std::size_t kAgentPrefixLength = 11;
  constexpr std::size_t kContentPrefixLength = 13;
  constexpr std::size_t kBatchPrefixLength = 13;
  constexpr std::size_t kUuidLength = 36;
  constexpr std::size_t kSuffixLength = 5;
  std::size_t prefix_length = 0;
  if (name.compare(0, kAgentRebuildPrefixLength, "agent-node-rebuild-") == 0) {
    prefix_length = kAgentRebuildPrefixLength;
  } else if (name.compare(0, kAgentPrefixLength, "agent-node-") == 0) {
    prefix_length = kAgentPrefixLength;
  } else if (name.compare(0, kContentPrefixLength, "content-node-") == 0) {
    prefix_length = kContentPrefixLength;
  } else if (name.compare(0, kBatchPrefixLength, "canvas-batch-") == 0) {
    prefix_length = kBatchPrefixLength;
  } else {
    return false;
  }
  if (name.size() != prefix_length + kUuidLength + kSuffixLength
      || name.compare(prefix_length + kUuidLength, kSuffixLength, ".json") != 0) return false;
  const std::string uuid = name.substr(prefix_length, kUuidLength);
  for (std::size_t index = 0; index < uuid.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (uuid[index] != '-') return false;
    } else if (!IsHexDigit(uuid[index])) {
      return false;
    }
  }
  const char version = uuid[14];
  const char variant = static_cast<char>(uuid[19] | 0x20);
  return version >= '1' && version <= '5'
      && (variant == '8' || variant == '9' || variant == 'a' || variant == 'b');
}

// Canvas intent 写结果区分 rename 前失败、正常提交和 rename 后持久性未确认。
struct CanvasIntentWriteOutcome {
  bool commit_visible = false;
  bool durability_uncertain = false;
  std::string error;
};

// 序列化结构化写结果；输入提交状态，返回单行 JSON。
std::string CanvasIntentWriteResultJson(const CanvasIntentWriteOutcome& outcome) {
  std::ostringstream out;
  out << "{\"type\":\"write-result\",\"commitVisible\":"
      << (outcome.commit_visible ? "true" : "false")
      << ",\"durabilityUncertain\":"
      << (outcome.durability_uncertain ? "true" : "false");
  if (!outcome.error.empty()) out << ",\"error\":\"" << JsonEscape(outcome.error) << '\"';
  out << '}';
  return out.str();
}

// 序列化 Canvas 内容目录 move 结果；字段语义与原子写保持一致。
std::string CanvasContentMoveResultJson(const CanvasIntentWriteOutcome& outcome) {
  std::ostringstream out;
  out << "{\"type\":\"move-result\",\"commitVisible\":"
      << (outcome.commit_visible ? "true" : "false")
      << ",\"durabilityUncertain\":"
      << (outcome.durability_uncertain ? "true" : "false");
  if (!outcome.error.empty()) out << ",\"error\":\"" << JsonEscape(outcome.error) << '"';
  out << '}';
  return out.str();
}

// 序列化 Canvas 内容文件读取结果；不返回路径，仅返回稳定身份与内存正文。
std::string CanvasContentReadResultJson(const std::string& status, const std::string& content,
                                        std::uint64_t size, const std::string& volume,
                                        const std::string& file_id, const std::string& error) {
  std::ostringstream out;
  out << "{\"type\":\"read-result\",\"status\":\"" << status << '"';
  if (status == "ok") {
    out << ",\"content\":\"" << JsonEscape(content) << "\",\"size\":" << size
        << ",\"volume\":\"" << JsonEscape(volume) << "\",\"fileId\":\""
        << JsonEscape(file_id) << '"';
  } else if (!error.empty()) {
    out << ",\"error\":\"" << JsonEscape(error) << '"';
  }
  out << '}';
  return out.str();
}

// 序列化 Canvas 内容根下的安全 entry 目录；不暴露绝对路径。
std::string CanvasContentEntryJson(const std::string& name) {
  return "{\"type\":\"entry\",\"rootIndex\":0,\"name\":\"" + JsonEscape(name)
      + "\",\"path\":\"\",\"isDirectory\":true}";
}

// 解析 ALLOW 或 ALLOW\t<Base64> 决策；写模式返回已解码正文。
bool ParseAuthorization(const Config& config, const std::string& decision, std::string* payload) {
  if (config.mode != "canvas-intent-write" && config.mode != "canvas-content-write") {
    return decision == "ALLOW";
  }
  constexpr char kPrefix[] = "ALLOW\t";
  if (decision.rfind(kPrefix, 0) != 0) return false;
  const std::size_t limit = config.mode == "canvas-content-write"
      ? kCanvasContentMaxFileBytes : 64 * 1024;
  return DecodeBase64(decision.substr(sizeof(kPrefix) - 1), limit, payload);
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

// 把 Windows drive/UNC 绝对路径转换为 extended-length 形式；已扩展路径保持不变。
[[maybe_unused]] std::string ToExtendedWindowsPath(const std::string& path) {
  if (path.rfind("\\\\?\\", 0) == 0) return path;
  if (path.rfind("\\\\", 0) == 0) return "\\\\?\\UNC\\" + path.substr(2);
  if (path.size() >= 3 && path[1] == ':' && (path[2] == '\\' || path[2] == '/')) {
    std::string normalized = path;
    std::replace(normalized.begin(), normalized.end(), '/', '\\');
    return "\\\\?\\" + normalized;
  }
  return path;
}

// 把 extended-length 路径转换为用户可见 canonical；UNC 恢复双反斜杠前缀。
[[maybe_unused]] std::string WindowsPathForDisplay(const std::string& path) {
  if (path.rfind("\\\\?\\UNC\\", 0) == 0) return "\\\\" + path.substr(8);
  if (path.rfind("\\\\?\\", 0) == 0) return path.substr(4);
  return path;
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

// 序列化内存中的 Canvas intent；正文由 helper 相对打开并读取，不返回可再次打开的绝对路径。
std::string CanvasIntentEntryJson(const std::string& name, bool is_directory,
                                  std::uint64_t size, const std::string& content) {
  std::ostringstream out;
  out << "{\"type\":\"entry\",\"rootIndex\":0,\"name\":\"" << JsonEscape(name)
      << "\",\"path\":\"\",\"isDirectory\":" << (is_directory ? "true" : "false");
  if (!is_directory) {
    out << ",\"size\":" << size << ",\"content\":\"" << JsonEscape(content) << '"';
  }
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

// 在固定内部普通文件上持有跨进程排他锁，析构时解锁并关闭 fd。
class CanvasIntentLock {
 public:
  CanvasIntentLock() = default;
  ~CanvasIntentLock() {
    if (locked_) flock(descriptor_.Get(), LOCK_UN);
  }
  CanvasIntentLock(const CanvasIntentLock&) = delete;
  CanvasIntentLock& operator=(const CanvasIntentLock&) = delete;

  // 相对 transactions fd 安全打开固定锁文件并阻塞取得排他锁。
  bool Acquire(int transactions_fd, std::string* error) {
    int open_error = 0;
    for (int attempt = 0; attempt < 32 && descriptor_.Get() < 0; ++attempt) {
      descriptor_.Reset(openat(transactions_fd, kCanvasIntentLockName,
          O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
      if (descriptor_.Get() >= 0) break;
      open_error = errno;
      if (open_error != EEXIST) break;
      descriptor_.Reset(openat(transactions_fd, kCanvasIntentLockName,
          O_RDWR | O_NOFOLLOW | O_CLOEXEC));
      if (descriptor_.Get() >= 0) break;
      open_error = errno;
      if (open_error != ENOENT) break;
    }
    if (descriptor_.Get() < 0) {
      *error = open_error == ELOOP ? "canvas intent lock is unsafe" : "cannot open canvas intent lock";
      return false;
    }
    struct stat identity {};
    if (fstat(descriptor_.Get(), &identity) != 0
        || !S_ISREG(identity.st_mode)
        || identity.st_nlink != 1) {
      *error = "canvas intent lock is unsafe";
      return false;
    }
    while (flock(descriptor_.Get(), LOCK_EX) != 0) {
      if (errno == EINTR) continue;
      *error = "cannot lock canvas intent";
      return false;
    }
    locked_ = true;
    return true;
  }

 private:
  UniqueFd descriptor_;
  bool locked_ = false;
};

// 在 Canvas root 固定普通文件上持有内容操作跨进程排他锁。
class CanvasContentLock {
 public:
  ~CanvasContentLock() { if (locked_) flock(descriptor_.Get(), LOCK_UN); }
  bool Acquire(int canvas_root_fd, std::string* error) {
    descriptor_.Reset(openat(canvas_root_fd, kCanvasContentLockName,
        O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600));
    struct stat identity {};
    if (descriptor_.Get() < 0 || fstat(descriptor_.Get(), &identity) != 0
        || !S_ISREG(identity.st_mode) || identity.st_nlink != 1) {
      *error = "canvas content lock is unsafe";
      return false;
    }
    while (flock(descriptor_.Get(), LOCK_EX) != 0) {
      if (errno == EINTR) continue;
      *error = "cannot lock canvas content";
      return false;
    }
    locked_ = true;
    return true;
  }
 private:
  UniqueFd descriptor_;
  bool locked_ = false;
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
  DIR* raw_directory = fdopendir(duplicate.Get());
  if (!raw_directory) return false;
  duplicate.Release();
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

// 仅通过已授权 Canvas root fd 创建并打开 transactions，拒绝链接或非目录替换。
bool OpenCanvasTransactions(const Config& config, const StableRoot& root,
                            UniqueFd* transactions, std::string* error) {
  if (!S_ISDIR(root.identity.st_mode)) {
    *error = "canvas root is not a directory";
    return false;
  }
  if (mkdirat(root.descriptor.Get(), config.child_name.c_str(), 0700) != 0 && errno != EEXIST) {
    *error = "cannot create canvas transactions directory";
    return false;
  }
  transactions->Reset(openat(root.descriptor.Get(), config.child_name.c_str(),
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (transactions->Get() < 0) {
    *error = "cannot open canvas transactions directory";
    return false;
  }
  struct stat identity {};
  if (fstat(transactions->Get(), &identity) != 0 || !S_ISDIR(identity.st_mode)) {
    *error = "canvas transactions entry is not a directory";
    return false;
  }
  return true;
}

// 把完整正文写入已打开临时 fd；返回写入和落盘是否全部成功。
bool WriteAndSync(int descriptor, const std::string& payload) {
  std::size_t offset = 0;
  while (offset < payload.size()) {
    const ssize_t written = write(descriptor, payload.data() + offset, payload.size() - offset);
    if (written <= 0) return false;
    offset += static_cast<std::size_t>(written);
  }
  return fsync(descriptor) == 0;
}

// 在两个已打开目录之间执行禁止覆盖的原子 rename。
bool RenameDirectoryNoReplace(int source_fd, const std::string& source_name,
                              int destination_fd, const std::string& destination_name) {
#ifdef __APPLE__
  return renameatx_np(source_fd, source_name.c_str(), destination_fd,
      destination_name.c_str(), RENAME_EXCL) == 0;
#elif defined(__linux__)
  constexpr unsigned int kRenameNoReplace = 1;
  return syscall(SYS_renameat2, source_fd, source_name.c_str(), destination_fd,
      destination_name.c_str(), kRenameNoReplace) == 0;
#else
  errno = ENOTSUP;
  return false;
#endif
}

// 在已授权 Canvas root 下创建或打开固定 nodes/trash 根，禁止 symlink 和非目录对象。
bool OpenCanvasContentRoot(const StableRoot& root, const std::string& name, bool create,
                           UniqueFd* directory, bool* missing, std::string* error) {
  *missing = false;
  if (!S_ISDIR(root.identity.st_mode)) { *error = "canvas root is not a directory"; return false; }
  if (create && mkdirat(root.descriptor.Get(), name.c_str(), 0700) != 0 && errno != EEXIST) {
    *error = "cannot create canvas content root";
    return false;
  }
  directory->Reset(openat(root.descriptor.Get(), name.c_str(),
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (directory->Get() < 0 && !create && errno == ENOENT) { *missing = true; return true; }
  struct stat identity {};
  if (directory->Get() < 0 || fstat(directory->Get(), &identity) != 0 || !S_ISDIR(identity.st_mode)) {
    *error = "canvas content root is unsafe";
    return false;
  }
  return true;
}

// 在固定内容根下创建或打开单个安全 entry 目录。
bool OpenCanvasContentEntry(int content_root_fd, const std::string& entry_id, bool create,
                            UniqueFd* entry, bool* missing, std::string* error) {
  *missing = false;
  if (create && mkdirat(content_root_fd, entry_id.c_str(), 0700) != 0 && errno != EEXIST) {
    *error = "cannot create canvas content entry";
    return false;
  }
  entry->Reset(openat(content_root_fd, entry_id.c_str(),
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (entry->Get() < 0 && !create && errno == ENOENT) { *missing = true; return true; }
  struct stat identity {};
  if (entry->Get() < 0 || fstat(entry->Get(), &identity) != 0 || !S_ISDIR(identity.st_mode)) {
    *error = "canvas content entry is unsafe";
    return false;
  }
  return true;
}

// 在内容锁临界区内统计目标 scope 的安全普通 entry；已有目标不占新增额度。
bool CheckCanvasContentCapacity(const Config& config, int content_root_fd,
                                const std::string& target_entry_id, std::string* error) {
  struct stat target {};
  if (fstatat(content_root_fd, target_entry_id.c_str(), &target, AT_SYMLINK_NOFOLLOW) == 0) return true;
  if (errno != ENOENT) { *error = "cannot inspect canvas content capacity target"; return false; }
  UniqueFd duplicate(dup(content_root_fd));
  if (duplicate.Get() < 0) { *error = "cannot duplicate canvas content root"; return false; }
  DIR* raw_directory = fdopendir(duplicate.Get());
  if (!raw_directory) { *error = "cannot enumerate canvas content root"; return false; }
  duplicate.Release();
  std::unique_ptr<DIR, int (*)(DIR*)> directory(raw_directory, closedir);
  std::size_t count = 0;
  while (dirent* item = readdir(directory.get())) {
    const std::string name(item->d_name);
    if (name.empty() || name.size() > 128) continue;
    bool valid_name = true;
    for (unsigned char value : name) {
      if (!((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
          || (value >= '0' && value <= '9') || value == '_' || value == '-')) valid_name = false;
    }
    if (!valid_name) continue;
    struct stat listed {};
    if (fstatat(content_root_fd, name.c_str(), &listed, AT_SYMLINK_NOFOLLOW) != 0
        || !S_ISDIR(listed.st_mode)) continue;
    UniqueFd opened(openat(content_root_fd, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    struct stat opened_identity {};
    if (opened.Get() < 0 || fstat(opened.Get(), &opened_identity) != 0
        || opened_identity.st_dev != listed.st_dev || opened_identity.st_ino != listed.st_ino) continue;
    ++count;
    if (count >= config.max_entries) {
      *error = "canvas content entry limit exceeded";
      return false;
    }
  }
  return true;
}

// 在安全 entry fd 内原子覆盖一个白名单文件，返回 rename 精确阶段。
CanvasIntentWriteOutcome WriteCanvasContentAtomic(const Config& config, const StableRoot& root,
                                                  const std::string& payload) {
  CanvasIntentWriteOutcome outcome;
  CanvasContentLock lock;
  if (!lock.Acquire(root.descriptor.Get(), &outcome.error)) return outcome;
  UniqueFd content_root;
  bool missing = false;
  if (!OpenCanvasContentRoot(root, config.child_name, true, &content_root, &missing, &outcome.error)) return outcome;
  if (!CheckCanvasContentCapacity(config, content_root.Get(), config.entry_id, &outcome.error)) return outcome;
  UniqueFd entry;
  if (!OpenCanvasContentEntry(content_root.Get(), config.entry_id, true, &entry, &missing, &outcome.error)) return outcome;
  // 覆盖前检查叶子本身，避免把符号链接或其它特殊对象替换为普通文件。
  struct stat existing {};
  if (fstatat(entry.Get(), config.file_name.c_str(), &existing, AT_SYMLINK_NOFOLLOW) == 0) {
    if (!S_ISREG(existing.st_mode)) {
      outcome.error = "canvas content file is unsafe";
      return outcome;
    }
  } else if (errno != ENOENT) {
    outcome.error = "canvas content file is unsafe";
    return outcome;
  }
  std::string temporary_name;
  UniqueFd temporary;
  for (int attempt = 0; attempt < 32; ++attempt) {
    temporary_name = ".content-" + std::to_string(getpid()) + "-"
        + std::to_string(static_cast<unsigned long long>(std::random_device{}())) + ".tmp";
    temporary.Reset(openat(entry.Get(), temporary_name.c_str(),
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
    if (temporary.Get() >= 0) break;
    if (errno != EEXIST) { outcome.error = "cannot create canvas content temporary file"; return outcome; }
  }
  if (temporary.Get() < 0) { outcome.error = "cannot allocate canvas content temporary file"; return outcome; }
  if (!WriteAndSync(temporary.Get(), payload)) {
    unlinkat(entry.Get(), temporary_name.c_str(), 0);
    outcome.error = "cannot persist canvas content temporary file";
    return outcome;
  }
  if (renameat(entry.Get(), temporary_name.c_str(), entry.Get(), config.file_name.c_str()) != 0) {
    unlinkat(entry.Get(), temporary_name.c_str(), 0);
    outcome.error = "cannot commit canvas content file";
    return outcome;
  }
  outcome.commit_visible = true;
  const bool entry_persisted = fsync(entry.Get()) == 0;
  const bool content_root_persisted = fsync(content_root.Get()) == 0;
  const bool canvas_root_persisted = fsync(root.descriptor.Get()) == 0;
  if (!entry_persisted || !content_root_persisted || !canvas_root_persisted) {
    outcome.durability_uncertain = true;
    outcome.error = "cannot persist canvas content directories";
  }
  return outcome;
}

// 比较 POSIX 内容文件的稳定身份、大小与纳秒时间状态。
bool SameCanvasContentFileState(const struct stat& left, const struct stat& right) {
  if (left.st_dev != right.st_dev || left.st_ino != right.st_ino
      || left.st_size != right.st_size || !S_ISREG(right.st_mode)) return false;
#ifdef __APPLE__
  return left.st_mtimespec.tv_sec == right.st_mtimespec.tv_sec
      && left.st_mtimespec.tv_nsec == right.st_mtimespec.tv_nsec
      && left.st_ctimespec.tv_sec == right.st_ctimespec.tv_sec
      && left.st_ctimespec.tv_nsec == right.st_ctimespec.tv_nsec;
#else
  return left.st_mtim.tv_sec == right.st_mtim.tv_sec
      && left.st_mtim.tv_nsec == right.st_mtim.tv_nsec
      && left.st_ctim.tv_sec == right.st_ctim.tv_sec
      && left.st_ctim.tv_nsec == right.st_ctim.tv_nsec;
#endif
}

// 在安全 entry 内 no-follow 读取白名单文件，并绑定路径与 fd 的稳定身份。
std::string ReadCanvasContent(const Config& config, const StableRoot& root) {
  CanvasContentLock lock;
  std::string error;
  if (!lock.Acquire(root.descriptor.Get(), &error)) {
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", error);
  }
  UniqueFd content_root;
  bool missing = false;
  if (!OpenCanvasContentRoot(root, config.child_name, false, &content_root, &missing, &error)) {
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", error);
  }
  if (missing) return CanvasContentReadResultJson("missing", "", 0, "", "", "");
  UniqueFd entry;
  if (!OpenCanvasContentEntry(content_root.Get(), config.entry_id, false, &entry, &missing, &error)) {
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", error);
  }
  if (missing) return CanvasContentReadResultJson("missing", "", 0, "", "", "");
  struct stat listed {};
  if (fstatat(entry.Get(), config.file_name.c_str(), &listed, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return CanvasContentReadResultJson("missing", "", 0, "", "", "");
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", "cannot stat canvas content file");
  }
  if (!S_ISREG(listed.st_mode) || listed.st_nlink != 1 || listed.st_size < 0
      || listed.st_size > static_cast<off_t>(kCanvasContentMaxFileBytes)) {
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", "canvas content file is unsafe");
  }
  UniqueFd file(openat(entry.Get(), config.file_name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
  struct stat opened {};
  if (file.Get() < 0 || fstat(file.Get(), &opened) != 0
      || !SameCanvasContentFileState(listed, opened)) {
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", "canvas content file changed before read");
  }
  std::string content(static_cast<std::size_t>(opened.st_size), '\0');
  std::size_t offset = 0;
  while (offset < content.size()) {
    const ssize_t count = read(file.Get(), content.data() + offset, content.size() - offset);
    if (count <= 0) return CanvasContentReadResultJson("corrupt", "", 0, "", "", "cannot read canvas content file");
    offset += static_cast<std::size_t>(count);
  }
  struct stat final_file {};
  struct stat final_path {};
  if (fstat(file.Get(), &final_file) != 0
      || fstatat(entry.Get(), config.file_name.c_str(), &final_path, AT_SYMLINK_NOFOLLOW) != 0
      || !SameCanvasContentFileState(opened, final_file)
      || !SameCanvasContentFileState(opened, final_path)) {
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", "canvas content file changed during read");
  }
  return CanvasContentReadResultJson("ok", content, static_cast<std::uint64_t>(opened.st_size),
      std::to_string(opened.st_dev), std::to_string(opened.st_ino), "");
}

// 确定性列出固定内容根下的合法普通 entry 目录，忽略链接和杂项。
bool ListCanvasContent(const Config& config, const StableRoot& root,
                       EntryBudget* budget, std::string* error) {
  CanvasContentLock lock;
  if (!lock.Acquire(root.descriptor.Get(), error)) return false;
  UniqueFd content_root;
  bool missing = false;
  if (!OpenCanvasContentRoot(root, config.child_name, false, &content_root, &missing, error)) return false;
  if (missing) return true;
  UniqueFd duplicate(dup(content_root.Get()));
  if (duplicate.Get() < 0) { *error = "cannot duplicate canvas content root"; return false; }
  DIR* raw_directory = fdopendir(duplicate.Get());
  if (!raw_directory) { *error = "cannot enumerate canvas content root"; return false; }
  duplicate.Release();
  std::unique_ptr<DIR, int (*)(DIR*)> directory(raw_directory, closedir);
  std::vector<std::string> names;
  while (dirent* item = readdir(directory.get())) {
    const std::string name(item->d_name);
    if (name.empty() || name.size() > 128) continue;
    bool valid_name = true;
    for (unsigned char value : name) {
      if (!((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
          || (value >= '0' && value <= '9') || value == '_' || value == '-')) valid_name = false;
    }
    if (!valid_name) continue;
    struct stat listed {};
    if (fstatat(content_root.Get(), name.c_str(), &listed, AT_SYMLINK_NOFOLLOW) != 0
        || !S_ISDIR(listed.st_mode)) continue;
    UniqueFd opened(openat(content_root.Get(), name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    struct stat opened_identity {};
    if (opened.Get() < 0 || fstat(opened.Get(), &opened_identity) != 0
        || opened_identity.st_dev != listed.st_dev || opened_identity.st_ino != listed.st_ino) continue;
    names.push_back(name);
  }
  std::sort(names.begin(), names.end());
  if (names.size() > config.max_entries) { *error = "canvas content entry limit exceeded"; return false; }
  for (const std::string& name : names) {
    if (!EmitLine(CanvasContentEntryJson(name), config, budget)) return false;
    ++budget->entries;
  }
  return true;
}

// 在固定 nodes/trash 根之间相对原子移动 entry 目录，目标必须不存在。
CanvasIntentWriteOutcome MoveCanvasContent(const Config& config, const StableRoot& root) {
  CanvasIntentWriteOutcome outcome;
  CanvasContentLock lock;
  if (!lock.Acquire(root.descriptor.Get(), &outcome.error)) return outcome;
  UniqueFd source_root;
  UniqueFd destination_root;
  bool missing = false;
  if (!OpenCanvasContentRoot(root, config.child_name, false, &source_root, &missing, &outcome.error)) return outcome;
  if (missing) { outcome.error = "canvas content move source missing"; return outcome; }
  if (!OpenCanvasContentRoot(root, config.destination_child_name, true, &destination_root, &missing, &outcome.error)) return outcome;
  struct stat source {};
  if (fstatat(source_root.Get(), config.entry_id.c_str(), &source, AT_SYMLINK_NOFOLLOW) != 0
      || !S_ISDIR(source.st_mode)) { outcome.error = "canvas content move source is unsafe"; return outcome; }
  struct stat destination {};
  if (fstatat(destination_root.Get(), config.destination_entry_id.c_str(), &destination, AT_SYMLINK_NOFOLLOW) == 0) {
    outcome.error = "canvas content move destination exists";
    return outcome;
  }
  if (errno != ENOENT) { outcome.error = "cannot inspect canvas content move destination"; return outcome; }
  if (!CheckCanvasContentCapacity(config, destination_root.Get(),
      config.destination_entry_id, &outcome.error)) return outcome;
  if (!RenameDirectoryNoReplace(source_root.Get(), config.entry_id,
      destination_root.Get(), config.destination_entry_id)) {
    outcome.error = errno == EEXIST ? "canvas content move destination exists"
                                    : "cannot commit canvas content move";
    return outcome;
  }
  outcome.commit_visible = true;
  const bool source_persisted = fsync(source_root.Get()) == 0;
  const bool destination_persisted = fsync(destination_root.Get()) == 0;
  const bool canvas_root_persisted = fsync(root.descriptor.Get()) == 0;
  if (!source_persisted || !destination_persisted || !canvas_root_persisted) {
    outcome.durability_uncertain = true;
    outcome.error = "cannot persist canvas content move";
  }
  return outcome;
}

// 写入前在同一 transactions fd 下统计合法普通 intent；覆盖不占新名额。
bool CheckCanvasIntentCapacity(const Config& config, int transactions_fd, std::string* error) {
  UniqueFd duplicate(dup(transactions_fd));
  if (duplicate.Get() < 0) { *error = "cannot duplicate canvas transactions directory"; return false; }
  DIR* raw_directory = fdopendir(duplicate.Get());
  if (!raw_directory) { *error = "cannot enumerate canvas transactions directory"; return false; }
  duplicate.Release();
  std::unique_ptr<DIR, int (*)(DIR*)> directory(raw_directory, closedir);
  std::size_t count = 0;
  bool target_exists = false;
  while (dirent* item = readdir(directory.get())) {
    const std::string name(item->d_name);
    if (!IsCanvasIntentCandidateName(name)) continue;
    struct stat listed {};
    if (fstatat(transactions_fd, name.c_str(), &listed, AT_SYMLINK_NOFOLLOW) != 0) {
      *error = "cannot stat canvas intent entry";
      return false;
    }
    if (!S_ISREG(listed.st_mode)) continue;
    ++count;
    if (name == config.file_name) target_exists = true;
  }
  if (!target_exists && count >= config.max_entries) {
    *error = "canvas intent entry limit exceeded";
    return false;
  }
  return true;
}

// 在 transactions fd 内创建临时文件、落盘并相对 rename，返回精确提交阶段。
CanvasIntentWriteOutcome WriteCanvasIntentAtomic(const Config& config, int transactions_fd,
                                                 const std::string& payload) {
  CanvasIntentWriteOutcome outcome;
  CanvasIntentLock lock;
  if (!lock.Acquire(transactions_fd, &outcome.error)) return outcome;
  if (!CheckCanvasIntentCapacity(config, transactions_fd, &outcome.error)) return outcome;
  std::string temporary_name;
  UniqueFd temporary;
  for (int attempt = 0; attempt < 32; ++attempt) {
    temporary_name = ".intent-" + std::to_string(getpid()) + "-"
        + std::to_string(static_cast<unsigned long long>(std::random_device{}())) + ".tmp";
    temporary.Reset(openat(transactions_fd, temporary_name.c_str(),
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
    if (temporary.Get() >= 0) break;
    if (errno != EEXIST) {
      outcome.error = "cannot create canvas intent temporary file";
      return outcome;
    }
  }
  if (temporary.Get() < 0) {
    outcome.error = "cannot allocate canvas intent temporary file";
    return outcome;
  }
  if (!WriteAndSync(temporary.Get(), payload)) {
    unlinkat(transactions_fd, temporary_name.c_str(), 0);
    outcome.error = "cannot persist canvas intent temporary file";
    return outcome;
  }
  if (renameat(transactions_fd, temporary_name.c_str(), transactions_fd, config.file_name.c_str()) != 0) {
    unlinkat(transactions_fd, temporary_name.c_str(), 0);
    outcome.error = "cannot commit canvas intent file";
    return outcome;
  }
  outcome.commit_visible = true;
  if (fsync(transactions_fd) != 0) {
    outcome.durability_uncertain = true;
    outcome.error = "cannot persist canvas transactions directory";
  }
  return outcome;
}

// 在同一 transactions fd 下列出并读取直接子项，读取前后复核稳定身份与纳秒时间戳。
bool ScanCanvasIntents(const Config& config, int transactions_fd,
                       EntryBudget* budget, std::string* error) {
  UniqueFd duplicate(dup(transactions_fd));
  if (duplicate.Get() < 0) { *error = "cannot duplicate canvas transactions directory"; return false; }
  DIR* raw_directory = fdopendir(duplicate.Get());
  if (!raw_directory) { *error = "cannot enumerate canvas transactions directory"; return false; }
  duplicate.Release();
  std::unique_ptr<DIR, int (*)(DIR*)> directory(raw_directory, closedir);
  while (dirent* item = readdir(directory.get())) {
    const std::string name(item->d_name);
    if (name == "." || name == "..") continue;
    if (!IsCanvasIntentCandidateName(name)) continue;
    struct stat listed {};
    if (fstatat(transactions_fd, name.c_str(), &listed, AT_SYMLINK_NOFOLLOW) != 0) {
      *error = "cannot stat canvas intent entry";
      return false;
    }
    if (!S_ISREG(listed.st_mode)) continue;
    if (budget->entries >= config.max_entries) {
      *error = "canvas intent entry limit exceeded";
      return false;
    }
    std::string content;
    if (S_ISREG(listed.st_mode)) {
      if (listed.st_size < 0 || listed.st_size > 64 * 1024) {
        *error = "invalid canvas intent file size";
        return false;
      }
      UniqueFd file(openat(transactions_fd, name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
      struct stat opened {};
      if (file.Get() < 0 || fstat(file.Get(), &opened) != 0
          || opened.st_dev != listed.st_dev || opened.st_ino != listed.st_ino
          || opened.st_size != listed.st_size
#ifdef __APPLE__
          || opened.st_mtimespec.tv_sec != listed.st_mtimespec.tv_sec
          || opened.st_mtimespec.tv_nsec != listed.st_mtimespec.tv_nsec
          || opened.st_ctimespec.tv_sec != listed.st_ctimespec.tv_sec
          || opened.st_ctimespec.tv_nsec != listed.st_ctimespec.tv_nsec
#else
          || opened.st_mtim.tv_sec != listed.st_mtim.tv_sec
          || opened.st_mtim.tv_nsec != listed.st_mtim.tv_nsec
          || opened.st_ctim.tv_sec != listed.st_ctim.tv_sec
          || opened.st_ctim.tv_nsec != listed.st_ctim.tv_nsec
#endif
      ) {
        *error = "canvas intent changed before read";
        return false;
      }
      content.resize(static_cast<std::size_t>(opened.st_size));
      std::size_t offset = 0;
      while (offset < content.size()) {
        const ssize_t count = read(file.Get(), content.data() + offset, content.size() - offset);
        if (count <= 0) { *error = "cannot read canvas intent"; return false; }
        offset += static_cast<std::size_t>(count);
      }
      struct stat final_state {};
      struct stat final_path_state {};
      if (fstat(file.Get(), &final_state) != 0
          || fstatat(transactions_fd, name.c_str(), &final_path_state, AT_SYMLINK_NOFOLLOW) != 0
          || final_state.st_dev != opened.st_dev || final_state.st_ino != opened.st_ino
          || final_state.st_size != opened.st_size
          || final_path_state.st_dev != opened.st_dev || final_path_state.st_ino != opened.st_ino
          || final_path_state.st_size != opened.st_size
#ifdef __APPLE__
          || final_state.st_mtimespec.tv_sec != opened.st_mtimespec.tv_sec
          || final_state.st_mtimespec.tv_nsec != opened.st_mtimespec.tv_nsec
          || final_state.st_ctimespec.tv_sec != opened.st_ctimespec.tv_sec
          || final_state.st_ctimespec.tv_nsec != opened.st_ctimespec.tv_nsec
          || final_path_state.st_mtimespec.tv_sec != opened.st_mtimespec.tv_sec
          || final_path_state.st_mtimespec.tv_nsec != opened.st_mtimespec.tv_nsec
          || final_path_state.st_ctimespec.tv_sec != opened.st_ctimespec.tv_sec
          || final_path_state.st_ctimespec.tv_nsec != opened.st_ctimespec.tv_nsec
#else
          || final_state.st_mtim.tv_sec != opened.st_mtim.tv_sec
          || final_state.st_mtim.tv_nsec != opened.st_mtim.tv_nsec
          || final_state.st_ctim.tv_sec != opened.st_ctim.tv_sec
          || final_state.st_ctim.tv_nsec != opened.st_ctim.tv_nsec
          || final_path_state.st_mtim.tv_sec != opened.st_mtim.tv_sec
          || final_path_state.st_mtim.tv_nsec != opened.st_mtim.tv_nsec
          || final_path_state.st_ctim.tv_sec != opened.st_ctim.tv_sec
          || final_path_state.st_ctim.tv_nsec != opened.st_ctim.tv_nsec
#endif
      ) {
        *error = "canvas intent changed during read";
        return false;
      }
    }
    if (!EmitLine(CanvasIntentEntryJson(name, false,
        static_cast<std::uint64_t>(listed.st_size), content), config, budget)) return false;
    ++budget->entries;
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
  std::string payload;
  if (!std::getline(std::cin, decision) || !ParseAuthorization(config, decision, &payload)) return 3;
  if (config.mode.rfind("canvas-content-", 0) == 0) {
    std::string error;
    if (config.mode == "canvas-content-write") {
      const CanvasIntentWriteOutcome outcome = WriteCanvasContentAtomic(config, roots.front(), payload);
      if (!EmitLine(CanvasIntentWriteResultJson(outcome), config, &budget)) return 4;
    } else if (config.mode == "canvas-content-read") {
      if (!EmitLine(ReadCanvasContent(config, roots.front()), config, &budget)) return 4;
    } else if (config.mode == "canvas-content-list") {
      if (!ListCanvasContent(config, roots.front(), &budget, &error)) {
        std::cerr << error << '\n';
        return 4;
      }
    } else {
      const CanvasIntentWriteOutcome outcome = MoveCanvasContent(config, roots.front());
      if (!EmitLine(CanvasContentMoveResultJson(outcome), config, &budget)) return 4;
    }
    std::ostringstream done;
    done << "{\"type\":\"done\",\"entryCount\":" << budget.entries << '}';
    return EmitLine(done.str(), config, &budget) ? 0 : 4;
  }
  if (config.mode == "canvas-intent-scan" || config.mode == "canvas-intent-write") {
    UniqueFd transactions;
    std::string error;
    if (!OpenCanvasTransactions(config, roots.front(), &transactions, &error)) {
      std::cerr << error << '\n';
      return 4;
    }
    if (config.mode == "canvas-intent-write") {
      const CanvasIntentWriteOutcome outcome = WriteCanvasIntentAtomic(
          config, transactions.Get(), payload);
      if (!EmitLine(CanvasIntentWriteResultJson(outcome), config, &budget)) return 4;
    } else {
      if (!ScanCanvasIntents(config, transactions.Get(), &budget, &error)) {
        std::cerr << error << '\n';
        return 4;
      }
    }
    std::ostringstream done;
    done << "{\"type\":\"done\",\"entryCount\":" << budget.entries << '}';
    return EmitLine(done.str(), config, &budget) ? 0 : 4;
  }
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

#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif

using NtCreateFileFunction = NTSTATUS (NTAPI *)(
    PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER,
    ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using RtlNtStatusToDosErrorFunction = ULONG (WINAPI *)(NTSTATUS);

// 通过 NtCreateFile 的 RootDirectory 相对打开对象，禁止路径重新解析到已授权根之外。
bool OpenRelativeWindows(HANDLE RootDirectory, const std::wstring& name,
                         ACCESS_MASK access, ULONG disposition, ULONG options,
                         UniqueHandle* output, std::string* error) {
  if (name.empty() || name.size() * sizeof(wchar_t) > USHRT_MAX) {
    *error = "invalid relative Windows name";
    return false;
  }
  const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  const auto nt_create_file = reinterpret_cast<NtCreateFileFunction>(
      ntdll ? GetProcAddress(ntdll, "NtCreateFile") : nullptr);
  if (!nt_create_file) { *error = "NtCreateFile unavailable"; return false; }
  UNICODE_STRING relative_name {};
  relative_name.Buffer = const_cast<PWSTR>(name.data());
  relative_name.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  relative_name.MaximumLength = relative_name.Length;
  OBJECT_ATTRIBUTES attributes {};
  InitializeObjectAttributes(&attributes, &relative_name, OBJ_CASE_INSENSITIVE, RootDirectory, nullptr);
  IO_STATUS_BLOCK status_block {};
  HANDLE handle = INVALID_HANDLE_VALUE;
  const NTSTATUS status = nt_create_file(
      &handle, access, &attributes, &status_block, nullptr, FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, disposition,
      options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, nullptr, 0);
  if (status < 0 || handle == INVALID_HANDLE_VALUE) {
    const auto rtl_nt_status_to_dos_error = reinterpret_cast<RtlNtStatusToDosErrorFunction>(
        ntdll ? GetProcAddress(ntdll, "RtlNtStatusToDosError") : nullptr);
    SetLastError(rtl_nt_status_to_dos_error ? rtl_nt_status_to_dos_error(status) : ERROR_GEN_FAILURE);
    *error = "cannot open relative Windows object";
    return false;
  }
  output->Reset(handle);
  return true;
}

// 在固定内部普通文件上持有 Windows 跨进程排他锁，析构时解锁并关闭 HANDLE。
class CanvasIntentLock {
 public:
  CanvasIntentLock() = default;
  ~CanvasIntentLock() {
    if (locked_) UnlockFileEx(handle_.Get(), 0, 1, 0, &overlapped_);
  }
  CanvasIntentLock(const CanvasIntentLock&) = delete;
  CanvasIntentLock& operator=(const CanvasIntentLock&) = delete;

  // 相对 transactions HANDLE 打开固定锁文件，拒绝 reparse/非普通文件后阻塞加锁。
  bool Acquire(HANDLE transactions, std::string* error) {
    std::string open_error;
    if (!OpenRelativeWindows(transactions, Utf8ToWide(kCanvasIntentLockName),
        FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN_IF, FILE_NON_DIRECTORY_FILE, &handle_, &open_error)) {
      *error = "canvas intent lock is unsafe";
      return false;
    }
    BY_HANDLE_FILE_INFORMATION identity {};
    if (!GetFileInformationByHandle(handle_.Get(), &identity)
        || (identity.dwFileAttributes
            & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0
        || identity.nNumberOfLinks != 1) {
      *error = "canvas intent lock is unsafe";
      return false;
    }
    if (!LockFileEx(handle_.Get(), LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &overlapped_)) {
      *error = "cannot lock canvas intent";
      return false;
    }
    locked_ = true;
    return true;
  }

 private:
  UniqueHandle handle_;
  OVERLAPPED overlapped_ {};
  bool locked_ = false;
};

// 在 Canvas root 固定普通文件上持有 Windows 内容操作排他锁。
class CanvasContentLock {
 public:
  ~CanvasContentLock() {
    if (locked_) UnlockFileEx(handle_.Get(), 0, 1, 0, &overlapped_);
  }
  bool Acquire(HANDLE canvas_root, std::string* error) {
    std::string open_error;
    if (!OpenRelativeWindows(canvas_root, Utf8ToWide(kCanvasContentLockName),
        FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN_IF, FILE_NON_DIRECTORY_FILE, &handle_, &open_error)) {
      *error = "canvas content lock is unsafe";
      return false;
    }
    BY_HANDLE_FILE_INFORMATION identity {};
    if (!GetFileInformationByHandle(handle_.Get(), &identity)
        || (identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0
        || identity.nNumberOfLinks != 1) {
      *error = "canvas content lock is unsafe";
      return false;
    }
    if (!LockFileEx(handle_.Get(), LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &overlapped_)) {
      *error = "cannot lock canvas content";
      return false;
    }
    locked_ = true;
    return true;
  }
 private:
  UniqueHandle handle_;
  OVERLAPPED overlapped_ {};
  bool locked_ = false;
};

// 读取 Windows 句柄身份与内容时间状态，供读取前后完整绑定。
bool ReadWindowsFileState(HANDLE handle, BY_HANDLE_FILE_INFORMATION* identity, FILE_BASIC_INFO* basic) {
  return GetFileInformationByHandle(handle, identity)
      && GetFileInformationByHandleEx(handle, FileBasicInfo, basic, sizeof(*basic));
}

// 比较 Windows intent 的 volume/fileId/size/lastWrite/changeTime 状态。
bool SameWindowsFileState(const BY_HANDLE_FILE_INFORMATION& left,
                          const FILE_BASIC_INFO& left_basic,
                          const BY_HANDLE_FILE_INFORMATION& right,
                          const FILE_BASIC_INFO& right_basic) {
  return left.dwVolumeSerialNumber == right.dwVolumeSerialNumber
      && left.nFileIndexHigh == right.nFileIndexHigh
      && left.nFileIndexLow == right.nFileIndexLow
      && left.nFileSizeHigh == right.nFileSizeHigh
      && left.nFileSizeLow == right.nFileSizeLow
      && left_basic.LastWriteTime.QuadPart == right_basic.LastWriteTime.QuadPart
      && left_basic.ChangeTime.QuadPart == right_basic.ChangeTime.QuadPart;
}

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
bool OpenStableRoot(const std::string& requested_path, StableRoot* root, std::string* error,
                    bool content_access = false) {
  const std::wstring requested = Utf8ToWide(ToExtendedWindowsPath(requested_path));
  if (requested.empty()) { *error = "invalid UTF-8 root"; return false; }
  const DWORD access = FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY
      | (content_access ? FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD : 0);
  UniqueHandle handle(CreateFileW(requested.c_str(), access,
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
  const std::wstring extended_final_path(final_path.data(), length);
  root->requested_path = requested_path;
  root->canonical_path = WindowsPathForDisplay(WideToUtf8(extended_final_path));
  root->canonical_wide = extended_final_path;
  root->identity = identity;
  root->handle = std::move(handle);
  return true;
}

// 仅通过已授权 Canvas HANDLE 相对创建或打开 transactions，并拒绝 reparse point。
bool OpenCanvasTransactions(const Config& config, const StableRoot& root,
                            UniqueHandle* transactions, std::string* error) {
  if ((root.identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    *error = "canvas root is not a directory";
    return false;
  }
  const std::wstring name = Utf8ToWide(config.child_name);
  if (!OpenRelativeWindows(root.handle.Get(), name,
      FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD
          | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_OPEN_IF, FILE_DIRECTORY_FILE, transactions, error)) return false;
  BY_HANDLE_FILE_INFORMATION identity {};
  if (!GetFileInformationByHandle(transactions->Get(), &identity)
      || (identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
      || (identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    *error = "canvas transactions entry is a reparse point or not a directory";
    return false;
  }
  return true;
}

// 标记同一目录句柄中的临时文件删除，供任一步失败时回收。
void DeleteTemporaryWindowsFile(HANDLE handle) {
  FILE_DISPOSITION_INFO disposition {};
  disposition.DeleteFile = TRUE;
  SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition));
}

// 相对 Canvas HANDLE 创建或打开固定 nodes/trash 根，并拒绝 reparse point。
bool OpenCanvasContentRootWindows(const StableRoot& root, const std::string& name, bool create,
                                  UniqueHandle* directory, bool* missing, std::string* error) {
  *missing = false;
  if ((root.identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    *error = "canvas root is not a directory";
    return false;
  }
  if (!OpenRelativeWindows(root.handle.Get(), Utf8ToWide(name),
      FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD
          | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      create ? FILE_OPEN_IF : FILE_OPEN, FILE_DIRECTORY_FILE, directory, error)) {
    const DWORD open_error = GetLastError();
    if (!create && IsCanvasWindowsMissingError(open_error)) { *missing = true; return true; }
    *error = create ? "cannot create canvas content root" : "cannot open canvas content root";
    return false;
  }
  BY_HANDLE_FILE_INFORMATION identity {};
  if (!GetFileInformationByHandle(directory->Get(), &identity)
      || (identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
      || (identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    *error = "canvas content root is unsafe";
    return false;
  }
  return true;
}

// 相对固定内容根创建或打开安全 entry 目录。
bool OpenCanvasContentEntryWindows(HANDLE content_root, const std::string& entry_id, bool create,
                                   UniqueHandle* entry, bool* missing, std::string* error) {
  *missing = false;
  if (!OpenRelativeWindows(content_root, Utf8ToWide(entry_id),
      FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD
          | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
      create ? FILE_OPEN_IF : FILE_OPEN, FILE_DIRECTORY_FILE, entry, error)) {
    const DWORD open_error = GetLastError();
    if (!create && IsCanvasWindowsMissingError(open_error)) { *missing = true; return true; }
    *error = create ? "cannot create canvas content entry" : "cannot open canvas content entry";
    return false;
  }
  BY_HANDLE_FILE_INFORMATION identity {};
  if (!GetFileInformationByHandle(entry->Get(), &identity)
      || (identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
      || (identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    *error = "canvas content entry is unsafe";
    return false;
  }
  return true;
}

// 在内容锁临界区内统计目标 scope 的安全普通 entry；已有目标不占新增额度。
bool CheckCanvasContentCapacity(const Config& config, HANDLE content_root,
                                const std::string& target_entry_id, std::string* error) {
  UniqueHandle target;
  std::string target_error;
  if (OpenRelativeWindows(content_root, Utf8ToWide(target_entry_id),
      FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_OPEN, 0, &target, &target_error)) return true;
  const DWORD target_open_error = GetLastError();
  if (!IsCanvasWindowsMissingError(target_open_error)) {
    *error = "cannot inspect canvas content capacity target";
    return false;
  }
  std::vector<unsigned char> buffer(64 * 1024);
  bool restart = true;
  std::size_t count = 0;
  while (true) {
    if (!GetFileInformationByHandleEx(content_root,
        restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
        buffer.data(), static_cast<DWORD>(buffer.size()))) {
      if (GetLastError() == ERROR_NO_MORE_FILES) break;
      *error = "cannot enumerate canvas content root";
      return false;
    }
    restart = false;
    unsigned char* cursor = buffer.data();
    while (true) {
      auto* item = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(cursor);
      const std::wstring name(item->FileName, item->FileNameLength / sizeof(wchar_t));
      const std::string utf8_name = WideToUtf8(name);
      bool safe_name = !utf8_name.empty() && utf8_name.size() <= 128;
      for (unsigned char value : utf8_name) {
        if (!((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
            || (value >= '0' && value <= '9') || value == '_' || value == '-')) safe_name = false;
      }
      if (safe_name
          && (item->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0
          && (item->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) {
        UniqueHandle opened;
        std::string open_error;
        if (OpenRelativeWindows(content_root, name,
            FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_OPEN, FILE_DIRECTORY_FILE, &opened, &open_error)) {
          BY_HANDLE_FILE_INFORMATION identity {};
          if (GetFileInformationByHandle(opened.Get(), &identity)
              && (identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0
              && WindowsFileId(identity) == static_cast<std::uint64_t>(item->FileId.QuadPart)) {
            ++count;
            if (count >= config.max_entries) {
              *error = "canvas content entry limit exceeded";
              return false;
            }
          }
        }
      }
      if (item->NextEntryOffset == 0) break;
      cursor += item->NextEntryOffset;
    }
  }
  return true;
}

// Windows 目录 flush 失败一律标记持久性未确认，禁止把权限或句柄错误当成成功。
bool FlushCanvasDirectoryWindows(HANDLE directory) {
  const bool flush_succeeded = FlushFileBuffers(directory) != FALSE;
  const DWORD error = flush_succeeded ? ERROR_SUCCESS : GetLastError();
  return IsCanvasWindowsDirectoryFlushDurable(flush_succeeded, error);
}

// 在安全 entry HANDLE 内原子覆盖白名单文件。
CanvasIntentWriteOutcome WriteCanvasContentAtomic(const Config& config, const StableRoot& root,
                                                  const std::string& payload) {
  CanvasIntentWriteOutcome outcome;
  CanvasContentLock lock;
  if (!lock.Acquire(root.handle.Get(), &outcome.error)) return outcome;
  UniqueHandle content_root;
  UniqueHandle entry;
  bool missing = false;
  if (!OpenCanvasContentRootWindows(root, config.child_name, true,
      &content_root, &missing, &outcome.error)) return outcome;
  if (!CheckCanvasContentCapacity(config, content_root.Get(), config.entry_id, &outcome.error)) return outcome;
  if (!OpenCanvasContentEntryWindows(content_root.Get(), config.entry_id, true,
      &entry, &missing, &outcome.error)) return outcome;
  // 相对 entry HANDLE 检查现有叶子；普通文件可覆盖，目录与 reparse point 一律拒绝。
  UniqueHandle existing;
  std::string existing_error;
  if (OpenRelativeWindows(entry.Get(), Utf8ToWide(config.file_name),
      FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_OPEN, 0, &existing, &existing_error)) {
    BY_HANDLE_FILE_INFORMATION identity {};
    if (!GetFileInformationByHandle(existing.Get(), &identity)
        || (identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
      outcome.error = "canvas content file is unsafe";
      return outcome;
    }
  } else {
    const DWORD open_error = GetLastError();
    if (!IsCanvasWindowsMissingError(open_error)) {
      outcome.error = "canvas content file is unsafe";
      return outcome;
    }
  }
  UniqueHandle temporary;
  for (int attempt = 0; attempt < 32; ++attempt) {
    const std::wstring name = L".content-" + std::to_wstring(GetCurrentProcessId()) + L"-"
        + std::to_wstring(static_cast<unsigned long long>(std::random_device{}())) + L".tmp";
    if (OpenRelativeWindows(entry.Get(), name,
        FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
        FILE_CREATE, FILE_NON_DIRECTORY_FILE, &temporary, &outcome.error)) break;
  }
  if (temporary.Get() == INVALID_HANDLE_VALUE) {
    outcome.error = "cannot allocate canvas content temporary file";
    return outcome;
  }
  std::size_t offset = 0;
  while (offset < payload.size()) {
    const DWORD remaining = static_cast<DWORD>(std::min<std::size_t>(payload.size() - offset, MAXDWORD));
    DWORD written = 0;
    if (!WriteFile(temporary.Get(), payload.data() + offset, remaining, &written, nullptr) || written == 0) {
      DeleteTemporaryWindowsFile(temporary.Get());
      outcome.error = "cannot write canvas content temporary file";
      return outcome;
    }
    offset += written;
  }
  if (!FlushFileBuffers(temporary.Get())) {
    DeleteTemporaryWindowsFile(temporary.Get());
    outcome.error = "cannot persist canvas content temporary file";
    return outcome;
  }
  const std::wstring target = Utf8ToWide(config.file_name);
  const std::size_t rename_size = offsetof(FILE_RENAME_INFO, FileName) + target.size() * sizeof(wchar_t);
  std::vector<unsigned char> rename_buffer(rename_size);
  auto* rename_info = reinterpret_cast<FILE_RENAME_INFO*>(rename_buffer.data());
  rename_info->ReplaceIfExists = TRUE;
  rename_info->RootDirectory = entry.Get();
  rename_info->FileNameLength = static_cast<DWORD>(target.size() * sizeof(wchar_t));
  std::memcpy(rename_info->FileName, target.data(), rename_info->FileNameLength);
  if (!SetFileInformationByHandle(temporary.Get(), FileRenameInfo,
      rename_info, static_cast<DWORD>(rename_buffer.size()))) {
    DeleteTemporaryWindowsFile(temporary.Get());
    outcome.error = "cannot commit canvas content file";
    return outcome;
  }
  outcome.commit_visible = true;
  const bool entry_persisted = FlushCanvasDirectoryWindows(entry.Get());
  const bool content_root_persisted = FlushCanvasDirectoryWindows(content_root.Get());
  const bool canvas_root_persisted = FlushCanvasDirectoryWindows(root.handle.Get());
  if (!entry_persisted || !content_root_persisted || !canvas_root_persisted) {
    outcome.durability_uncertain = true;
    outcome.error = "cannot persist canvas content directories";
  }
  return outcome;
}

// 从安全 entry HANDLE no-follow 读取白名单文件并复核稳定身份。
std::string ReadCanvasContent(const Config& config, const StableRoot& root) {
  CanvasContentLock lock;
  std::string error;
  if (!lock.Acquire(root.handle.Get(), &error)) {
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", error);
  }
  UniqueHandle content_root;
  UniqueHandle entry;
  bool missing = false;
  if (!OpenCanvasContentRootWindows(root, config.child_name, false,
      &content_root, &missing, &error)) {
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", error);
  }
  if (missing) return CanvasContentReadResultJson("missing", "", 0, "", "", "");
  if (!OpenCanvasContentEntryWindows(content_root.Get(), config.entry_id, false,
      &entry, &missing, &error)) {
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", error);
  }
  if (missing) return CanvasContentReadResultJson("missing", "", 0, "", "", "");
  UniqueHandle file;
  if (!OpenRelativeWindows(entry.Get(), Utf8ToWide(config.file_name),
      FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_OPEN, FILE_NON_DIRECTORY_FILE, &file, &error)) {
    return IsCanvasWindowsMissingError(GetLastError())
      ? CanvasContentReadResultJson("missing", "", 0, "", "", "")
      : CanvasContentReadResultJson("corrupt", "", 0, "", "", "cannot open canvas content file");
  }
  BY_HANDLE_FILE_INFORMATION initial {};
  FILE_BASIC_INFO initial_basic {};
  if (!ReadWindowsFileState(file.Get(), &initial, &initial_basic)
      || (initial.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0
      || initial.nNumberOfLinks != 1) {
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", "canvas content file is unsafe");
  }
  const std::uint64_t size = (static_cast<std::uint64_t>(initial.nFileSizeHigh) << 32)
      | initial.nFileSizeLow;
  if (size > kCanvasContentMaxFileBytes) {
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", "canvas content file is unsafe");
  }
  std::string content(static_cast<std::size_t>(size), '\0');
  std::size_t offset = 0;
  while (offset < content.size()) {
    DWORD read_bytes = 0;
    if (!ReadFile(file.Get(), content.data() + offset,
        static_cast<DWORD>(content.size() - offset), &read_bytes, nullptr) || read_bytes == 0) {
      return CanvasContentReadResultJson("corrupt", "", 0, "", "", "cannot read canvas content file");
    }
    offset += read_bytes;
  }
  BY_HANDLE_FILE_INFORMATION final_state {};
  FILE_BASIC_INFO final_basic {};
  UniqueHandle final_path;
  BY_HANDLE_FILE_INFORMATION final_path_state {};
  FILE_BASIC_INFO final_path_basic {};
  if (!ReadWindowsFileState(file.Get(), &final_state, &final_basic)
      || !OpenRelativeWindows(entry.Get(), Utf8ToWide(config.file_name),
          FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_OPEN, FILE_NON_DIRECTORY_FILE, &final_path, &error)
      || !ReadWindowsFileState(final_path.Get(), &final_path_state, &final_path_basic)
      || !SameWindowsFileState(initial, initial_basic, final_state, final_basic)
      || !SameWindowsFileState(initial, initial_basic, final_path_state, final_path_basic)) {
    return CanvasContentReadResultJson("corrupt", "", 0, "", "", "canvas content file changed during read");
  }
  return CanvasContentReadResultJson("ok", content, size,
      std::to_string(initial.dwVolumeSerialNumber), std::to_string(WindowsFileId(initial)), "");
}

// 确定性列出固定内容根下合法、非 reparse 的直接 entry 目录。
bool ListCanvasContent(const Config& config, const StableRoot& root,
                       EntryBudget* budget, std::string* error) {
  CanvasContentLock lock;
  if (!lock.Acquire(root.handle.Get(), error)) return false;
  UniqueHandle content_root;
  bool missing = false;
  if (!OpenCanvasContentRootWindows(root, config.child_name, false,
      &content_root, &missing, error)) return false;
  if (missing) return true;
  std::vector<unsigned char> buffer(64 * 1024);
  std::vector<std::string> names;
  bool restart = true;
  while (true) {
    if (!GetFileInformationByHandleEx(content_root.Get(),
        restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
        buffer.data(), static_cast<DWORD>(buffer.size()))) {
      if (GetLastError() == ERROR_NO_MORE_FILES) break;
      *error = "cannot enumerate canvas content root";
      return false;
    }
    restart = false;
    unsigned char* cursor = buffer.data();
    while (true) {
      auto* item = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(cursor);
      const std::wstring name(item->FileName, item->FileNameLength / sizeof(wchar_t));
      const std::string utf8_name = WideToUtf8(name);
      bool safe_name = !utf8_name.empty() && utf8_name.size() <= 128;
      for (unsigned char value : utf8_name) {
        if (!((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
            || (value >= '0' && value <= '9') || value == '_' || value == '-')) safe_name = false;
      }
      if (safe_name
          && (item->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0
          && (item->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) {
        UniqueHandle opened;
        std::string open_error;
        if (OpenRelativeWindows(content_root.Get(), name,
            FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_OPEN, FILE_DIRECTORY_FILE, &opened, &open_error)) {
          BY_HANDLE_FILE_INFORMATION identity {};
          if (GetFileInformationByHandle(opened.Get(), &identity)
              && (identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0
              && WindowsFileId(identity) == static_cast<std::uint64_t>(item->FileId.QuadPart)) {
            names.push_back(utf8_name);
          }
        }
      }
      if (item->NextEntryOffset == 0) break;
      cursor += item->NextEntryOffset;
    }
  }
  std::sort(names.begin(), names.end());
  if (names.size() > config.max_entries) { *error = "canvas content entry limit exceeded"; return false; }
  for (const std::string& name : names) {
    if (!EmitLine(CanvasContentEntryJson(name), config, budget)) return false;
    ++budget->entries;
  }
  return true;
}

// 在固定 nodes/trash HANDLE 之间原子移动 entry 目录，禁止覆盖目标。
CanvasIntentWriteOutcome MoveCanvasContent(const Config& config, const StableRoot& root) {
  CanvasIntentWriteOutcome outcome;
  CanvasContentLock lock;
  if (!lock.Acquire(root.handle.Get(), &outcome.error)) return outcome;
  UniqueHandle source_root;
  UniqueHandle destination_root;
  bool missing = false;
  if (!OpenCanvasContentRootWindows(root, config.child_name, false,
      &source_root, &missing, &outcome.error)) return outcome;
  if (missing) { outcome.error = "canvas content move source missing"; return outcome; }
  if (!OpenCanvasContentRootWindows(root, config.destination_child_name, true,
      &destination_root, &missing, &outcome.error)) return outcome;
  UniqueHandle source;
  if (!OpenCanvasContentEntryWindows(source_root.Get(), config.entry_id, false,
      &source, &missing, &outcome.error) || missing) {
    outcome.error = missing ? "canvas content move source missing" : "canvas content move source is unsafe";
    return outcome;
  }
  UniqueHandle destination;
  std::string destination_error;
  bool destination_missing = false;
  if (!OpenCanvasContentEntryWindows(destination_root.Get(), config.destination_entry_id, false,
      &destination, &destination_missing, &destination_error)) {
    outcome.error = destination_error;
    return outcome;
  }
  if (!destination_missing) {
    outcome.error = "canvas content move destination exists";
    return outcome;
  }
  if (!CheckCanvasContentCapacity(config, destination_root.Get(),
      config.destination_entry_id, &outcome.error)) return outcome;
  const std::wstring target = Utf8ToWide(config.destination_entry_id);
  const std::size_t rename_size = offsetof(FILE_RENAME_INFO, FileName) + target.size() * sizeof(wchar_t);
  std::vector<unsigned char> rename_buffer(rename_size);
  auto* rename_info = reinterpret_cast<FILE_RENAME_INFO*>(rename_buffer.data());
  rename_info->ReplaceIfExists = FALSE;
  rename_info->RootDirectory = destination_root.Get();
  rename_info->FileNameLength = static_cast<DWORD>(target.size() * sizeof(wchar_t));
  std::memcpy(rename_info->FileName, target.data(), rename_info->FileNameLength);
  if (!SetFileInformationByHandle(source.Get(), FileRenameInfo,
      rename_info, static_cast<DWORD>(rename_buffer.size()))) {
    outcome.error = "cannot commit canvas content move";
    return outcome;
  }
  outcome.commit_visible = true;
  const bool source_persisted = FlushCanvasDirectoryWindows(source_root.Get());
  const bool destination_persisted = FlushCanvasDirectoryWindows(destination_root.Get());
  const bool canvas_root_persisted = FlushCanvasDirectoryWindows(root.handle.Get());
  if (!source_persisted || !destination_persisted || !canvas_root_persisted) {
    outcome.durability_uncertain = true;
    outcome.error = "cannot persist canvas content move";
  }
  return outcome;
}

// 写入前在同一 transactions HANDLE 下统计合法普通 intent；覆盖不占新名额。
bool CheckCanvasIntentCapacity(const Config& config, HANDLE transactions, std::string* error) {
  std::vector<unsigned char> buffer(64 * 1024);
  bool restart = true;
  std::size_t count = 0;
  bool target_exists = false;
  const std::wstring target = Utf8ToWide(config.file_name);
  while (true) {
    if (!GetFileInformationByHandleEx(transactions,
        restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
        buffer.data(), static_cast<DWORD>(buffer.size()))) {
      if (GetLastError() == ERROR_NO_MORE_FILES) break;
      *error = "cannot enumerate canvas transactions directory";
      return false;
    }
    restart = false;
    unsigned char* cursor = buffer.data();
    while (true) {
      auto* item = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(cursor);
      const std::wstring name(item->FileName, item->FileNameLength / sizeof(wchar_t));
      const std::string utf8_name = WideToUtf8(name);
      const bool regular = (item->FileAttributes
          & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0;
      if (regular && IsCanvasIntentCandidateName(utf8_name)) {
        ++count;
        if (_wcsicmp(name.c_str(), target.c_str()) == 0) target_exists = true;
      }
      if (item->NextEntryOffset == 0) break;
      cursor += item->NextEntryOffset;
    }
  }
  if (!target_exists && count >= config.max_entries) {
    *error = "canvas intent entry limit exceeded";
    return false;
  }
  return true;
}

// 在 transactions HANDLE 下相对创建、落盘并 rename intent，返回精确提交阶段。
CanvasIntentWriteOutcome WriteCanvasIntentAtomic(const Config& config, HANDLE transactions,
                                                 const std::string& payload) {
  CanvasIntentWriteOutcome outcome;
  CanvasIntentLock lock;
  if (!lock.Acquire(transactions, &outcome.error)) return outcome;
  if (!CheckCanvasIntentCapacity(config, transactions, &outcome.error)) return outcome;
  UniqueHandle temporary;
  for (int attempt = 0; attempt < 32; ++attempt) {
    const std::wstring temporary_name = L".intent-" + std::to_wstring(GetCurrentProcessId())
        + L"-" + std::to_wstring(static_cast<unsigned long long>(std::random_device{}())) + L".tmp";
    if (OpenRelativeWindows(transactions, temporary_name,
        FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
        FILE_CREATE, FILE_NON_DIRECTORY_FILE, &temporary, &outcome.error)) break;
  }
  if (temporary.Get() == INVALID_HANDLE_VALUE) {
    outcome.error = "cannot allocate canvas intent temporary file";
    return outcome;
  }
  std::size_t offset = 0;
  while (offset < payload.size()) {
    const DWORD remaining = static_cast<DWORD>(std::min<std::size_t>(payload.size() - offset, MAXDWORD));
    DWORD written = 0;
    if (!WriteFile(temporary.Get(), payload.data() + offset, remaining, &written, nullptr) || written == 0) {
      DeleteTemporaryWindowsFile(temporary.Get());
      outcome.error = "cannot write canvas intent temporary file";
      return outcome;
    }
    offset += written;
  }
  if (!FlushFileBuffers(temporary.Get())) {
    DeleteTemporaryWindowsFile(temporary.Get());
    outcome.error = "cannot persist canvas intent temporary file";
    return outcome;
  }
  const std::wstring target = Utf8ToWide(config.file_name);
  const std::size_t rename_size = offsetof(FILE_RENAME_INFO, FileName) + target.size() * sizeof(wchar_t);
  std::vector<unsigned char> rename_buffer(rename_size);
  auto* rename_info = reinterpret_cast<FILE_RENAME_INFO*>(rename_buffer.data());
  rename_info->ReplaceIfExists = TRUE;
  rename_info->RootDirectory = transactions;
  rename_info->FileNameLength = static_cast<DWORD>(target.size() * sizeof(wchar_t));
  std::memcpy(rename_info->FileName, target.data(), rename_info->FileNameLength);
  if (!SetFileInformationByHandle(
      temporary.Get(), FileRenameInfo, rename_info, static_cast<DWORD>(rename_buffer.size()))) {
    DeleteTemporaryWindowsFile(temporary.Get());
    outcome.error = "cannot commit canvas intent file";
    return outcome;
  }
  outcome.commit_visible = true;
  /** Windows 对目录 FlushFileBuffers 的支持依文件系统而异；成功时强化 rename 元数据持久性。 */
  if (!FlushFileBuffers(transactions)) {
    const DWORD flush_error = GetLastError();
    if (flush_error != ERROR_INVALID_HANDLE && flush_error != ERROR_ACCESS_DENIED) {
      outcome.durability_uncertain = true;
      outcome.error = "cannot persist canvas transactions directory";
    }
  }
  return outcome;
}

// 从相对打开的 Windows intent HANDLE 读取正文并在读取前后绑定完整文件状态。
bool ReadCanvasIntentWindows(HANDLE transactions, const std::wstring& name,
                             std::uint64_t listed_file_id, std::string* content,
                             std::uint64_t* size, std::string* error) {
  UniqueHandle file;
  if (!OpenRelativeWindows(transactions, name,
      FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_OPEN, FILE_NON_DIRECTORY_FILE, &file, error)) return false;
  BY_HANDLE_FILE_INFORMATION initial {};
  FILE_BASIC_INFO initial_basic {};
  if (!ReadWindowsFileState(file.Get(), &initial, &initial_basic)
      || (initial.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0
      || WindowsFileId(initial) != listed_file_id) {
    *error = "canvas intent changed before read";
    return false;
  }
  *size = (static_cast<std::uint64_t>(initial.nFileSizeHigh) << 32) | initial.nFileSizeLow;
  if (*size > 64 * 1024) { *error = "invalid canvas intent file size"; return false; }
  content->resize(static_cast<std::size_t>(*size));
  std::size_t offset = 0;
  while (offset < content->size()) {
    DWORD read_bytes = 0;
    const DWORD remaining = static_cast<DWORD>(content->size() - offset);
    if (!ReadFile(file.Get(), content->data() + offset, remaining, &read_bytes, nullptr) || read_bytes == 0) {
      *error = "cannot read canvas intent";
      return false;
    }
    offset += read_bytes;
  }
  BY_HANDLE_FILE_INFORMATION final_state {};
  FILE_BASIC_INFO final_basic {};
  UniqueHandle final_path;
  BY_HANDLE_FILE_INFORMATION final_path_state {};
  FILE_BASIC_INFO final_path_basic {};
  if (!ReadWindowsFileState(file.Get(), &final_state, &final_basic)
      || !OpenRelativeWindows(transactions, name,
          FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_OPEN, FILE_NON_DIRECTORY_FILE, &final_path, error)
      || !ReadWindowsFileState(final_path.Get(), &final_path_state, &final_path_basic)
      || !SameWindowsFileState(initial, initial_basic, final_state, final_basic)
      || !SameWindowsFileState(initial, initial_basic, final_path_state, final_path_basic)) {
    *error = "canvas intent changed during read";
    return false;
  }
  return true;
}

// 直接枚举 transactions HANDLE，并把相对读取的 intent 正文放入协议内存结果。
bool ScanCanvasIntents(const Config& config, HANDLE transactions,
                       EntryBudget* budget, std::string* error) {
  std::vector<unsigned char> buffer(64 * 1024);
  bool restart = true;
  while (true) {
    if (!GetFileInformationByHandleEx(transactions,
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
        if (!IsCanvasIntentCandidateName(utf8_name)) {
          if (item->NextEntryOffset == 0) break;
          cursor += item->NextEntryOffset;
          continue;
        }
        const bool is_directory = (item->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if (is_directory || (item->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
          if (item->NextEntryOffset == 0) break;
          cursor += item->NextEntryOffset;
          continue;
        }
        if (budget->entries >= config.max_entries) {
          *error = "canvas intent entry limit exceeded";
          return false;
        }
        std::string content;
        std::uint64_t size = 0;
        if (!is_directory && !ReadCanvasIntentWindows(
            transactions, name, static_cast<std::uint64_t>(item->FileId.QuadPart),
            &content, &size, error)) return false;
        if (!EmitLine(CanvasIntentEntryJson(utf8_name, false, size, content), config, budget)) {
          return false;
        }
        ++budget->entries;
      }
      if (item->NextEntryOffset == 0) break;
      cursor += item->NextEntryOffset;
    }
  }
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
  const bool content_access = config.mode.rfind("canvas-content-", 0) == 0;
  for (std::size_t index = 0; index < config.roots.size(); ++index) {
    std::string error;
    if (!OpenStableRoot(config.roots[index], &roots[index], &error, content_access)) {
      std::cerr << error << '\n';
      return 2;
    }
  }
  EntryBudget budget;
  if (!EmitLine(OpenedJson(roots), config, &budget)) return 4;
  std::string decision;
  std::string payload;
  if (!std::getline(std::cin, decision) || !ParseAuthorization(config, decision, &payload)) return 3;
  if (content_access) {
    std::string error;
    if (config.mode == "canvas-content-write") {
      const CanvasIntentWriteOutcome outcome = WriteCanvasContentAtomic(config, roots.front(), payload);
      if (!EmitLine(CanvasIntentWriteResultJson(outcome), config, &budget)) return 4;
    } else if (config.mode == "canvas-content-read") {
      if (!EmitLine(ReadCanvasContent(config, roots.front()), config, &budget)) return 4;
    } else if (config.mode == "canvas-content-list") {
      if (!ListCanvasContent(config, roots.front(), &budget, &error)) {
        std::cerr << error << '\n';
        return 4;
      }
    } else {
      const CanvasIntentWriteOutcome outcome = MoveCanvasContent(config, roots.front());
      if (!EmitLine(CanvasContentMoveResultJson(outcome), config, &budget)) return 4;
    }
    std::ostringstream done;
    done << "{\"type\":\"done\",\"entryCount\":" << budget.entries << '}';
    return EmitLine(done.str(), config, &budget) ? 0 : 4;
  }
  if (config.mode == "canvas-intent-scan" || config.mode == "canvas-intent-write") {
    UniqueHandle transactions;
    std::string error;
    if (!OpenCanvasTransactions(config, roots.front(), &transactions, &error)) {
      std::cerr << error << '\n';
      return 4;
    }
    if (config.mode == "canvas-intent-write") {
      const CanvasIntentWriteOutcome outcome = WriteCanvasIntentAtomic(
          config, transactions.Get(), payload);
      if (!EmitLine(CanvasIntentWriteResultJson(outcome), config, &budget)) return 4;
    } else if (!ScanCanvasIntents(config, transactions.Get(), &budget, &error)) {
      std::cerr << error << '\n';
      return 4;
    }
    std::ostringstream done;
    done << "{\"type\":\"done\",\"entryCount\":" << budget.entries << '}';
    return EmitLine(done.str(), config, &budget) ? 0 : 4;
  }
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
[[maybe_unused]] int Run(const std::vector<std::string>& args) {
  Config config;
  std::string error;
  if (!ParseArguments(args, &config, &error)) {
    std::cerr << error << '\n';
    return 1;
  }
  return RunPlatform(config);
}

}  // namespace

#ifndef STABLE_DIRECTORY_HELPER_LIBRARY
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
#endif
