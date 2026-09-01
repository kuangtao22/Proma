#define STABLE_DIRECTORY_HELPER_LIBRARY
#include "stable-directory-helper.cc"

// 构造单根 Canvas 内容请求参数；调用方追加具体模式字段。
std::vector<std::string> CanvasContentArgs(const std::string& mode,
                                           const std::string& child_name) {
  return {
      "--mode", mode,
      "--root", "/canvas",
      "--max-entries", "512",
      "--child-name", child_name,
  };
}

// 执行参数合同校验；输入完整 argv 片段，返回 helper 是否接受。
bool AcceptsArguments(const std::vector<std::string>& args) {
  Config config;
  std::string error;
  return ParseArguments(args, &config, &error);
}

int main() {
  if (ToExtendedWindowsPath("C:\\work\\deep") != "\\\\?\\C:\\work\\deep") return 1;
  if (ToExtendedWindowsPath("\\\\server\\share\\deep") != "\\\\?\\UNC\\server\\share\\deep") return 2;
  if (ToExtendedWindowsPath("\\\\?\\C:\\work") != "\\\\?\\C:\\work") return 3;
  if (WindowsPathForDisplay("\\\\?\\C:\\work\\deep") != "C:\\work\\deep") return 4;
  if (WindowsPathForDisplay("\\\\?\\UNC\\server\\share\\deep") != "\\\\server\\share\\deep") return 5;
  auto revisions_write = CanvasContentArgs("canvas-content-write", "revisions");
  revisions_write.insert(revisions_write.end(), {
      "--entry-id", "revision-a", "--file-name", "content.md"});
  if (!AcceptsArguments(revisions_write)) return 6;
  auto revisions_read = CanvasContentArgs("canvas-content-read", "revisions");
  revisions_read.insert(revisions_read.end(), {
      "--entry-id", "revision-a", "--file-name", "meta.json"});
  if (!AcceptsArguments(revisions_read)) return 7;
  if (!AcceptsArguments(CanvasContentArgs("canvas-content-list", "revisions"))) return 8;
  auto revisions_move = CanvasContentArgs("canvas-content-move", "revisions");
  revisions_move.insert(revisions_move.end(), {
      "--entry-id", "revision-a", "--destination-child-name", "trash",
      "--destination-entry-id", "revision-a"});
  if (AcceptsArguments(revisions_move)) return 9;
  auto move_to_revisions = CanvasContentArgs("canvas-content-move", "nodes");
  move_to_revisions.insert(move_to_revisions.end(), {
      "--entry-id", "content-a", "--destination-child-name", "revisions",
      "--destination-entry-id", "revision-a"});
  if (AcceptsArguments(move_to_revisions)) return 10;
  auto arbitrary_file = CanvasContentArgs("canvas-content-write", "revisions");
  arbitrary_file.insert(arbitrary_file.end(), {
      "--entry-id", "revision-a", "--file-name", "payload.txt"});
  if (AcceptsArguments(arbitrary_file)) return 11;
  return 0;
}
